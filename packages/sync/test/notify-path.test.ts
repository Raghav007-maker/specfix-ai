import { describe, expect, it } from 'vitest';
import { instantEmail, notificationPath } from '../src/index.ts';

const project = '11111111-1111-4111-8111-111111111111';
const ticket = '22222222-2222-4222-8222-222222222222';

describe('notificationPath', () => {
  it('links a task notification to its task, a ticket one to its ticket', () => {
    expect(notificationPath(null, { projectId: project, number: 7 })).toBe(
      `/projects/${project}/tasks/7`
    );
    expect(notificationPath(ticket, {})).toBe(`/tickets/${ticket}`);
    expect(notificationPath(null, {})).toBe('/inbox');
  });

  it('never builds a link from malformed payload values', () => {
    for (const payload of [
      { projectId: '../../evil', number: 1 },
      { projectId: project, number: '7' },
      { projectId: project, number: -1 },
      { projectId: project, number: 1.5 },
    ]) {
      expect(notificationPath(null, payload)).toBe('/inbox');
    }
  });
});

describe('task emails', () => {
  it('names who assigned the task and links to it, escaping HTML', () => {
    const mail = instantEmail(
      {
        to: 'dev@example.test',
        kind: 'task_assigned',
        ticketId: null,
        payload: {
          projectId: project,
          number: 3,
          key: 'CF-3',
          title: '<b>Fix</b>',
          by: 'pm@x.test',
        },
      },
      'https://app.test'
    );
    expect(mail.subject).toBe('CF-3 · <b>Fix</b>: pm@x.test assigned you a task');
    expect(mail.text).toContain(`https://app.test/projects/${project}/tasks/3`);
    expect(mail.html).toContain('&lt;b&gt;Fix&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Fix</b>');
  });
});

describe('mention emails', () => {
  it('links a conversation mention to the conversation and quotes it, escaped', () => {
    expect(notificationPath(null, { chatProjectId: project })).toBe(
      `/projects/${project}/conversation`
    );
    expect(notificationPath(null, { chatProjectId: '../../x' })).toBe('/inbox');
    const mail = instantEmail(
      {
        to: 'dev@example.test',
        kind: 'mentioned',
        ticketId: null,
        payload: {
          chatProjectId: project,
          title: 'Checkout conversation',
          by: 'pm@x.test',
          excerpt: '@dev please look <script>x</script>',
        },
      },
      'https://app.test'
    );
    expect(mail.subject).toBe('Checkout conversation: pm@x.test mentioned you');
    expect(mail.text).toContain('"@dev please look <script>x</script>"');
    expect(mail.text).toContain(`https://app.test/projects/${project}/conversation`);
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
  });
});
