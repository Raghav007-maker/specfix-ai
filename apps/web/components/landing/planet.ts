/**
 * Earth in deep space for the landing and sign-in pages, drawn with one WebGL fragment shader.
 *
 * The surface comes from NASA's Blue Marble imagery (public domain), self-hosted in
 * `public/earth/` at 2048×1024: the day map, the night-lights map, a water mask for sun glint,
 * and a cloud layer (coverage as brightness) that drifts a little faster than the ground.
 * Without WebGL the canvas simply shows the space colour. Under prefers-reduced-motion the
 * planet is drawn once and holds still.
 */

export interface PlanetState {
  /** Centre and radius in CSS pixels, and the sun direction (need not be normalised). */
  x: number;
  y: number;
  r: number;
  sx: number;
  sy: number;
  sz: number;
}

export interface Planet {
  set(state: Partial<PlanetState>, instant?: boolean): void;
  dispose(): void;
}

const MAPS = {
  uDay: '/earth/day.jpg',
  uNight: '/earth/night.jpg',
  uWater: '/earth/water.jpg',
  uClouds: '/earth/clouds.jpg',
} as const;

const VERTEX = 'attribute vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }';

const FRAGMENT = `
precision highp float;
uniform vec2 uRes; uniform vec2 uC; uniform float uR; uniform float uT; uniform float uDpr; uniform vec3 uSun;
uniform sampler2D uDay; uniform sampler2D uNight; uniform sampler2D uWater; uniform sampler2D uClouds;
uniform float uReady; uniform float uCloudsReady; uniform vec3 uSpace0; uniform vec3 uSpace1;
const float PI=3.14159265;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
vec2 equirect(vec3 q){return vec2(atan(q.x,q.z)/(2.*PI)+.5,.5-asin(clamp(q.y,-1.,1.))/PI);}
vec3 toLin(vec3 c){return pow(c,vec3(2.2));}
void main(){
  vec2 fc=gl_FragCoord.xy;
  vec2 p=(fc-uC)/uR;
  float r2=dot(p,p);
  vec3 col=mix(uSpace0,uSpace1,fc.y/uRes.y);
  vec2 g=floor(fc/(2.2*uDpr));float h=hash(g);
  if(h>.9965){float tw=.65+.35*sin(uT*1.3+h*90.);col+=vec3(.8,.85,1.)*(h-.9965)*1.7*tw;}
  vec3 sun=normalize(uSun);
  if(r2<1.){
    vec3 n=vec3(p,sqrt(1.-r2));
    float spin=uT*.018;
    vec3 q=rotX(.36)*rotY(spin+1.9)*n;
    float nd=dot(n,sun);
    float day=smoothstep(-.12,.22,nd);
    float diff=max(nd,0.);
    vec3 surf;
    if(uReady>.5){
      vec2 uv=equirect(q);
      vec3 dayC=toLin(texture2D(uDay,uv).rgb);
      vec3 nightC=toLin(texture2D(uNight,uv).rgb);
      float water=texture2D(uWater,uv).r;
      dayC=mix(dayC,dayC*vec3(.85,.95,1.25),water*.6);
      surf=dayC*(.015+1.25*diff);
      vec3 hv=normalize(sun+vec3(0.,0.,1.));
      surf+=vec3(1.,.95,.85)*pow(max(dot(n,hv),0.),260.)*water*.16*day;
      float cl=0.;
      if(uCloudsReady>.5){
        vec3 cq=rotX(.36)*rotY(spin*1.25+1.9)*n;
        cl=smoothstep(.08,.9,texture2D(uClouds,equirect(cq)).r);
      }
      surf*=1.-cl*.25;
      surf=mix(surf,vec3(.95,.97,1.)*(.01+1.15*diff),cl*.92);
      surf+=nightC*vec3(1.,.78,.5)*1.35*(1.-day)*(1.-cl*.8);
    } else {
      surf=vec3(.02,.05,.12)*(.1+diff);
    }
    float fres=pow(1.-n.z,2.6);
    surf=mix(surf,vec3(.32,.58,1.)*(.12+.9*day),fres*.55);
    col=pow(surf,vec3(1./2.2));
  }
  float d=sqrt(r2);
  if(d>=1.){float a=exp(-(d-1.)*uR/(16.*uDpr));float sd=max(dot(normalize(vec3(p,.0001)),vec3(sun.xy,0.)),0.);
    col+=vec3(.25,.55,1.)*a*(.12+.6*sd);}
  gl_FragColor=vec4(col,1.);
}`;

/** Space colours: top and bottom of the canvas, as linear-ish RGB 0..1. */
const SPACE_TOP: [number, number, number] = [0.046, 0.034, 0.06];
const SPACE_BOTTOM: [number, number, number] = [0.03, 0.022, 0.04];

export function createPlanet(canvas: HTMLCanvasElement, opts: { maxDpr?: number } = {}): Planet {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) return { set() {}, dispose() {} };

  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const uRes = u('uRes'), uC = u('uC'), uR = u('uR'), uT = u('uT'), uDpr = u('uDpr');
  const uSun = u('uSun'), uReady = u('uReady'), uCloudsReady = u('uCloudsReady');
  gl.uniform3f(u('uSpace0'), ...SPACE_BOTTOM);
  gl.uniform3f(u('uSpace1'), ...SPACE_TOP);

  let surfaceMaps = 0;
  let clouds = 0;
  let disposed = false;
  (Object.keys(MAPS) as (keyof typeof MAPS)[]).forEach((name, unit) => {
    gl.uniform1i(u(name), unit);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    const img = new Image();
    img.onload = () => {
      if (disposed) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (name === 'uClouds') clouds = 1;
      else surfaceMaps++;
      if (reduce) draw();
    };
    img.src = MAPS[name];
  });

  let dpr = 1;
  let height = 0;
  let target: PlanetState = { x: 0, y: 0, r: 100, sx: -0.55, sy: 0.45, sz: 0.7 };
  let current: PlanetState | null = null;
  const start = performance.now();
  let raf = 0;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr ?? 1.5);
    height = canvas.clientHeight;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(height * dpr);
    gl!.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    if (disposed) return;
    if (!current) current = { ...target };
    const k = reduce ? 1 : 0.085;
    for (const key of Object.keys(target) as (keyof PlanetState)[]) {
      current[key] += (target[key] - current[key]) * k;
    }
    gl!.uniform2f(uRes, canvas.width, canvas.height);
    gl!.uniform2f(uC, current.x * dpr, (height - current.y) * dpr);
    gl!.uniform1f(uR, current.r * dpr);
    gl!.uniform1f(uT, reduce ? 0 : (performance.now() - start) / 1000);
    gl!.uniform1f(uDpr, dpr);
    gl!.uniform3f(uSun, current.sx, current.sy, current.sz);
    gl!.uniform1f(uReady, surfaceMaps >= 3 ? 1 : 0);
    gl!.uniform1f(uCloudsReady, clouds);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    if (!reduce && !document.hidden) raf = requestAnimationFrame(draw);
  }

  const onResize = () => {
    size();
    if (reduce) draw();
  };
  const onVisibility = () => {
    if (!document.hidden && !reduce) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  size();
  raf = requestAnimationFrame(draw);

  return {
    set(state, instant) {
      target = { ...target, ...state };
      if (instant || !current) current = { ...target };
      if (reduce) draw();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
