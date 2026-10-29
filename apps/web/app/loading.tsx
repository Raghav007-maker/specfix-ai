/**
 * Shown the moment a link is clicked, while the next page loads on the server, so navigation
 * never looks frozen. Same flat-bar style as the ticket page's loading state; no shimmer.
 */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="min-h-screen bg-frame lg:grid lg:grid-cols-[228px_minmax(0,1fr)] lg:grid-rows-[48px_minmax(0,1fr)]"
    >
      <span className="sr-only">Loading…</span>
      <div className="space-y-3 px-5 pt-4 max-lg:hidden lg:row-span-2">
        <div className="h-5 w-28 rounded-sm bg-active" />
        <div className="h-4 w-36 rounded-sm bg-active" />
        <div className="mt-6 h-4 w-32 rounded-sm bg-active" />
      </div>
      <div className="h-12 border-b border-border lg:border-0" />
      <div className="bg-sheet px-4 pt-5 md:px-6 lg:mb-2 lg:mr-2 lg:min-h-[calc(100vh-56px)] lg:rounded-sheet lg:border lg:border-border lg:pt-6">
        <div className="h-7 w-1/2 max-w-md rounded-sm bg-raised" />
        <div className="mt-6 space-y-3">
          <div className="h-14 rounded-sm bg-raised" />
          <div className="h-14 rounded-sm bg-raised" />
          <div className="h-14 rounded-sm bg-raised" />
        </div>
      </div>
    </div>
  );
}
