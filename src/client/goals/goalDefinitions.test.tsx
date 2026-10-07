// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalDefinitionFull, GoalDetail, GoalNextAction } from '../../shared/goalApi';
import type { GoalDefinition, GoalStatus } from '../../shared/goals';
import type { ProjectProfile } from '../../shared/types';
import { GoalsPage } from './GoalsPage';
import { calls, definitionFull, detail, item, openGoal, posts, refuse, serve, type Routes } from './testKit';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const project = (id: string, name: string) => ({ id, name, path: `/p/${id}` }) as unknown as ProjectProfile;
const PROJECTS = [project('project-1', 'Turing Terminal'), project('project-2', 'Other')];
const paths = () => posts().map((call) => `${call.method} ${call.path}`);
const gets = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;

interface World {
  goal: GoalDetail;
  defs: GoalDefinitionFull[];
}
const goalWith = (
  status: GoalStatus,
  nextAction: GoalNextAction,
  reasonCode: string | null = null,
  version: number | null = 1,
): GoalDetail =>
  detail({
    status,
    nextAction,
    reasonCode,
    currentDefinitionVersion: version,
    needsUser: status === 'needs_user' || status === 'blocked',
  });
const proposed = (version: number, overrides: Partial<GoalDefinitionFull> = {}) =>
  definitionFull(version, { status: 'proposed', approvedAt: null, approvedBy: null, ...overrides });

const summaries = (defs: GoalDefinitionFull[]) =>
  defs.map(({ definition: _d, validation: _v, goalId: _g, ...summary }) => summary);

function routesFor(world: World, extra: Routes = {}): Routes {
  const routes: Routes = {
    '/api/goals': () => ({ goals: [item()], total: 1, limit: 50 }),
    '/api/goals/goal-1': () => ({ goal: world.goal }),
    '/api/goals/goal-1/preview': () => ({ preview: {} }),
    '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
    '/api/goals/goal-1/definitions': () => ({ definitions: summaries(world.defs) }),
  };
  for (let version = 1; version <= 6; version += 1)
    routes[`/api/goals/goal-1/definitions/${version}`] = () => {
      const found = world.defs.find((d) => d.version === version);
      return found
        ? { definition: found }
        : refuse(404, 'No such definition version.', 'definition_not_found');
    };
  return { ...routes, ...extra };
}

async function openDefinitions(world: World, extra: Routes = {}) {
  serve(routesFor(world, extra));
  const user = userEvent.setup();
  render(<GoalsPage projects={PROJECTS} />);
  await openGoal(user);
  await screen.findByLabelText('Next action');
  await user.click(screen.getByRole('tab', { name: 'Definitions' }));
  return user;
}
const editor = () => screen.getByLabelText('Definition JSON') as HTMLTextAreaElement;
const edit = (text: string) => fireEvent.change(editor(), { target: { value: text } });
const persistedHash = () => document.querySelector('[data-persisted-hash]')?.textContent;
const OK_DOC = (outcome: string) => {
  const doc = JSON.parse(JSON.stringify(definitionFull(2).definition)) as GoalDefinition;
  doc.contract.outcome = outcome;
  return doc;
};

describe('Goal creation (7B.2B)', () => {
  async function openCreate(projects: ProjectProfile[] = PROJECTS, extra: Routes = {}) {
    serve({
      '/api/goals': () => ({ goals: [], total: 0, limit: 50 }),
      '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
      ...extra,
    });
    const user = userEvent.setup();
    render(<GoalsPage projects={projects} />);
    await user.click(await screen.findByRole('button', { name: /New Grand Project/ }));
    return user;
  }

  it('opens the creation form with no request and lists only the registered projects', async () => {
    await openCreate();
    const select = await screen.findByLabelText('Project');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a registered project…', 'Turing Terminal', 'Other']);
    expect(posts()).toEqual([]);
  });

  it('with no registered project it explains and points at the Projects page', async () => {
    const open = vi.fn();
    serve({ '/api/goals': () => ({ goals: [], total: 0, limit: 50 }) });
    const user = userEvent.setup();
    render(<GoalsPage projects={[]} onOpenProjects={open} />);
    await user.click(await screen.findByRole('button', { name: /New Grand Project/ }));
    expect(await screen.findByText(/No projects are registered yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Definition JSON')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Projects' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });

  it('sends nothing for a missing project, an empty title or malformed JSON', async () => {
    const user = await openCreate();
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Choose a project');
    await user.selectOptions(screen.getByLabelText('Project'), 'project-1');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a title');
    await user.type(screen.getByLabelText('Title'), 'Grand');
    fireEvent.change(editor(), { target: { value: '{"contract": ' } });
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing was sent/);
    fireEvent.change(editor(), { target: { value: '{"contract":{}}' } });
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('missing required section');
    expect(posts()).toEqual([]);
  });

  it('Create sends exactly projectId, title, definition and changeSummary, then opens the new draft; nothing else is sent', async () => {
    const doc = OK_DOC('Create me');
    const draft = goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null);
    const user = await openCreate(PROJECTS, {
      'POST /api/goals': () => ({
        goalId: 'goal-1',
        version: 1,
        definitionHash: 'h',
        validation: { valid: true, errors: [], warnings: [] },
      }),
      '/api/goals/goal-1': () => ({ goal: draft }),
      '/api/goals/goal-1/preview': () => ({ preview: {} }),
    });
    await user.selectOptions(screen.getByLabelText('Project'), 'project-2');
    await user.type(screen.getByLabelText('Title'), '  New thing  ');
    await user.type(screen.getByLabelText('Change summary (optional)'), 'first');
    fireEvent.change(editor(), { target: { value: JSON.stringify(doc) } });
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByLabelText('Next action');
    expect(paths()).toEqual(['POST /api/goals']);
    expect(posts()[0]!.body).toEqual({
      projectId: 'project-2',
      title: 'New thing',
      definition: doc,
      changeSummary: 'first',
    });
    expect(screen.queryByRole('button', { name: /Start Goal/ })).toBeNull();
  });

  it('omits an empty change summary and ignores a second click while the request is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    const user = await openCreate(PROJECTS, {
      'POST /api/goals': async () => {
        await gate;
        return {
          goalId: 'goal-1',
          version: 1,
          definitionHash: 'h',
          validation: { valid: true, errors: [], warnings: [] },
        };
      },
      '/api/goals/goal-1': () => ({
        goal: goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null),
      }),
      '/api/goals/goal-1/preview': () => ({ preview: {} }),
    });
    await user.selectOptions(screen.getByLabelText('Project'), 'project-1');
    await user.type(screen.getByLabelText('Title'), 'Once');
    fireEvent.change(editor(), { target: { value: JSON.stringify(OK_DOC('x')) } });
    const create = screen.getByRole('button', { name: 'Create draft' });
    await user.click(create);
    await user.click(screen.getByRole('button', { name: /Creating/ }));
    release(undefined);
    await screen.findByLabelText('Next action');
    expect(paths()).toEqual(['POST /api/goals']);
    expect(posts()[0]!.body).not.toHaveProperty('changeSummary');
  });

  it('renders a server refusal with its code and issue details, and stays on the form', async () => {
    const user = await openCreate(PROJECTS, {
      'POST /api/goals': () =>
        refuse(422, 'The definition is invalid.', 'definition_invalid', {
          detail: [
            {
              severity: 'error',
              path: 'limits.maxExecutionCycles',
              code: 'out_of_range',
              message: 'Too high.',
            },
          ],
        }),
    });
    await user.selectOptions(screen.getByLabelText('Project'), 'project-1');
    await user.type(screen.getByLabelText('Title'), 'Bad');
    fireEvent.change(editor(), { target: { value: JSON.stringify(OK_DOC('x')) } });
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    const alert = await screen.findByText(/Not created:/);
    const box = alert.closest('[data-refusal-code]')!;
    expect(box.getAttribute('data-refusal-code')).toBe('definition_invalid');
    expect(box.textContent).toContain('limits.maxExecutionCycles');
    expect(box.textContent).toContain('Too high.');
    expect(paths()).toEqual(['POST /api/goals']);
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeTruthy();
  });
});

describe('Definition editor (7B.2B)', () => {
  const draftWorld = (): World => ({
    goal: goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null),
    defs: [proposed(1)],
  });

  it('typing, Format and opening confirmations never mutate; Reset restores the persisted text', async () => {
    const world = draftWorld();
    const user = await openDefinitions(world);
    const original = ((await screen.findByLabelText('Definition JSON')) as HTMLTextAreaElement).value;
    edit('{"x": 1}');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    edit(JSON.stringify(OK_DOC('compact')));
    await user.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(editor().value).toContain('\n  "contract"');
    await user.click(screen.getByRole('button', { name: 'Reset to persisted' }));
    await user.click(screen.getByRole('button', { name: 'Discard edits' }));
    expect(editor().value).toBe(original);
    expect(screen.getByText('No unsaved changes')).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it('malformed JSON on Save sends no request and says where', async () => {
    const user = await openDefinitions(draftWorld());
    await screen.findByLabelText('Definition JSON');
    edit('{\n  "contract": ,\n}');
    await user.click(screen.getByRole('button', { name: 'Save proposed definition' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing was sent/);
    expect(posts()).toEqual([]);
  });

  it('Save issues exactly one PUT with the full document and optional summary, then shows the new hash and validation', async () => {
    const world = draftWorld();
    const next = OK_DOC('Saved outcome');
    const user = await openDefinitions(world, {
      'PUT /api/goals/goal-1/definitions/1': (body) => {
        const sent = body as { definition: typeof next };
        world.defs = [
          proposed(1, {
            definitionHash: 'newhash999999',
            definition: sent.definition,
            validation: {
              valid: false,
              errors: [
                { severity: 'error', path: 'milestones', code: 'empty', message: 'Needs a milestone.' },
              ],
              warnings: [],
            },
          }),
        ];
        return { definition: world.defs[0] };
      },
    });
    await screen.findByLabelText('Definition JSON');
    edit(JSON.stringify(next, null, 2));
    await user.type(screen.getByLabelText('Change summary (optional)'), 'tweak');
    await user.click(screen.getByRole('button', { name: 'Save proposed definition' }));
    await waitFor(() => expect(persistedHash()).toBe('newhash999'));
    expect(paths()).toEqual(['PUT /api/goals/goal-1/definitions/1']);
    expect(posts()[0]!.body).toEqual({ definition: next, changeSummary: 'tweak' });
    const report = screen.getByLabelText('Definition validation');
    expect(report.getAttribute('data-validation-valid')).toBe('false');
    expect(report.textContent).toContain('Needs a milestone.');
    expect(screen.getByText('No unsaved changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve definition v1/ }).hasAttribute('disabled')).toBe(true);
  });

  it('unsaved edits disable Approve until saved', async () => {
    const user = await openDefinitions(draftWorld());
    await screen.findByLabelText('Definition JSON');
    expect(screen.getByRole('button', { name: /Approve definition v1/ }).hasAttribute('disabled')).toBe(
      false,
    );
    edit(JSON.stringify(OK_DOC('changed')));
    const approve = screen.getByRole('button', { name: /Approve definition v1/ });
    expect(approve.hasAttribute('disabled')).toBe(true);
    await user.click(approve);
    expect(screen.queryByRole('alertdialog', { name: 'Confirm approve definition' })).toBeNull();
    expect(screen.getByText(/Save your changes before approving/)).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it('approved, superseded and rejected versions are read-only with no edit or authority controls', async () => {
    const world: World = {
      goal: goalWith('ready', { kind: 'start' }, null, 3),
      defs: [
        definitionFull(1, { status: 'superseded' }),
        definitionFull(2, { status: 'rejected', approvedAt: null, approvedBy: null }),
        definitionFull(3),
      ],
    };
    const user = await openDefinitions(world);
    await screen.findByLabelText('Definition v3');
    expect(screen.getByText(/Approved versions are immutable. Create a revision/)).toBeTruthy();
    for (const version of [1, 2]) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^v${version}`) }));
      await screen.findByLabelText(`Definition v${version}`);
      expect(screen.getByText(/historical and cannot be changed/)).toBeTruthy();
    }
    expect(screen.queryByLabelText('Definition JSON')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Save proposed|Approve definition|Reject proposed/ }),
    ).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('switching versions never shows the previous version content under the new label, and unsaved edits are guarded', async () => {
    const world: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 2 }),
      defs: [definitionFull(1, { status: 'superseded' }), proposed(2)],
    };
    const user = await openDefinitions(world);
    await screen.findByLabelText('Definition JSON');
    edit(JSON.stringify(OK_DOC('unsaved')));
    await user.click(screen.getByRole('button', { name: /^v1/ }));
    expect(await screen.findByRole('alertdialog', { name: 'Confirm leave' })).toBeTruthy();
    expect(screen.getByLabelText('Definition JSON')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(editor().value).toContain('unsaved');
    await user.click(screen.getByRole('button', { name: /^v1/ }));
    await user.click(screen.getByRole('button', { name: 'Discard and leave' }));
    const article = await screen.findByLabelText('Definition v1');
    expect(article.textContent).toContain('Outcome of version 1');
    expect(screen.queryByLabelText('Definition JSON')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('a persisted change under unsaved text disables Save and offers Reset', async () => {
    const world = draftWorld();
    const user = await openDefinitions(world);
    await screen.findByLabelText('Definition JSON');
    edit(JSON.stringify(OK_DOC('mine')));
    world.defs = [proposed(1, { definitionHash: 'elsewhere0000', definition: OK_DOC('theirs') as never })];
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/persisted proposal changed since you started editing/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save proposed definition' }).hasAttribute('disabled')).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Reset to persisted' }));
    await user.click(screen.getByRole('button', { name: 'Discard edits' }));
    expect(editor().value).toContain('theirs');
    expect(posts()).toEqual([]);
  });

  it('passive browsing is GET-only: opening Definitions, switching versions and Refresh', async () => {
    const world: World = {
      goal: goalWith('ready', { kind: 'start' }, null, 2),
      defs: [definitionFull(1, { status: 'superseded' }), definitionFull(2)],
    };
    const user = await openDefinitions(world);
    await screen.findByLabelText('Definition v2');
    await user.click(screen.getByRole('button', { name: /^v1/ }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(posts()).toEqual([]);
  });
});

describe('Definition approval and rejection (7B.2B)', () => {
  it('focuses exactly the version the server projects, not the latest or current', async () => {
    const world: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 3 }, 'user_revision', 1),
      defs: [
        definitionFull(1),
        definitionFull(2, { status: 'rejected', approvedAt: null, approvedBy: null }),
        proposed(3),
        proposed(4),
      ],
    };
    await openDefinitions(world);
    expect(await screen.findByLabelText('Edit proposed definition v3')).toBeTruthy();
    expect(screen.queryByLabelText('Edit proposed definition v4')).toBeNull();
  });

  it('shows a stale state and chooses nothing when the projected version is not a proposal', async () => {
    const world: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 2 }, null, 1),
      defs: [
        definitionFull(1),
        definitionFull(2, { status: 'rejected', approvedAt: null, approvedBy: null }),
      ],
    };
    await openDefinitions(world);
    expect(await screen.findByText(/not a proposal any more/)).toBeTruthy();
    expect(screen.queryByLabelText('Definition JSON')).toBeNull();
  });

  it('Approve confirms first, then POSTs only the version approve endpoint with an optional note and nothing else', async () => {
    const world: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null),
      defs: [
        proposed(1, {
          validation: {
            valid: true,
            errors: [],
            warnings: [{ severity: 'warning', path: 'a', code: 'w', message: 'careful' }],
          },
        }),
      ],
    };
    const user = await openDefinitions(world, {
      'POST /api/goals/goal-1/definitions/1/approve': () => {
        world.goal = goalWith('ready', { kind: 'start' }, 'definition_approved', 1);
        world.defs = [definitionFull(1)];
        return { version: 1, definitionHash: 'x', approvalId: 'ap-1', goalStatus: 'ready' };
      },
    });
    await screen.findByLabelText('Definition JSON');
    await user.click(screen.getByRole('button', { name: /Approve definition v1/ }));
    expect(posts()).toEqual([]);
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm approve definition' });
    expect(dialog.textContent).toContain('Initial definition');
    expect(dialog.textContent).toContain('immutable and current');
    expect(dialog.textContent).toContain('hash10000000'.slice(0, 5));
    await user.type(within(dialog).getByLabelText('Approval note (optional)'), 'ok');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(paths()).toEqual(['POST /api/goals/goal-1/definitions/1/approve']));
    expect(posts()[0]!.body).toEqual({ note: 'ok' });
    await waitFor(() => expect(screen.getByText(/Approved versions are immutable/)).toBeTruthy());
    expect(
      paths().some((p) => p.includes('goal-approvals') || p.includes('/start') || p.includes('/resume')),
    ).toBe(false);
  });

  it('an invalid persisted proposal is not approvable, and a server 422 on a stale client is shown with its issues', async () => {
    const invalid: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null),
      defs: [
        proposed(1, {
          validation: {
            valid: false,
            errors: [{ severity: 'error', path: 'p', code: 'bad', message: 'broken' }],
            warnings: [],
          },
        }),
      ],
    };
    await openDefinitions(invalid);
    await screen.findByLabelText('Definition JSON');
    expect(screen.getByRole('button', { name: /Approve definition v1/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Definition validation').textContent).toContain('broken');
    cleanup();

    const stale: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null),
      defs: [proposed(1)],
    };
    const user = await openDefinitions(stale, {
      'POST /api/goals/goal-1/definitions/1/approve': () =>
        refuse(422, 'The definition is invalid.', 'definition_invalid', {
          detail: [{ severity: 'error', path: 'routing', code: 'no_pool', message: 'No pool.' }],
        }),
    });
    await screen.findByLabelText('Definition JSON');
    await user.click(screen.getByRole('button', { name: /Approve definition v1/ }));
    await user.click(await screen.findByRole('button', { name: 'Confirm approval' }));
    const alert = await screen.findByText(/Not done:/);
    expect(alert.closest('[data-refusal-code]')!.textContent).toContain('No pool.');
    expect(paths()).toEqual(['POST /api/goals/goal-1/definitions/1/approve']);
    expect(posts()[0]!.body).toEqual({});
  });

  it('a Save changes the persisted hash, and the approval confirmation shows only the new persisted hash', async () => {
    const world: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null),
      defs: [proposed(1)],
    };
    const user = await openDefinitions(world, {
      'PUT /api/goals/goal-1/definitions/1': (body) => {
        world.defs = [
          proposed(1, {
            definitionHash: 'beta00000000',
            definition: (body as { definition: never }).definition,
          }),
        ];
        return { definition: world.defs[0] };
      },
    });
    await screen.findByLabelText('Definition JSON');
    await user.click(screen.getByRole('button', { name: /Approve definition v1/ }));
    expect(
      (await screen.findByRole('alertdialog', { name: 'Confirm approve definition' })).textContent,
    ).toContain('hash100000');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    edit(JSON.stringify(OK_DOC('beta')));
    await user.click(screen.getByRole('button', { name: 'Save proposed definition' }));
    await waitFor(() => expect(persistedHash()).toBe('beta000000'));
    // No stale confirmation survived the Save; a new one binds to the new hash and the approve body carries no hash.
    expect(screen.queryByRole('alertdialog', { name: 'Confirm approve definition' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Approve definition v1/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm approve definition' });
    expect(dialog.textContent).toContain('beta000000');
    expect(dialog.textContent).not.toContain('hash100000');
    expect(paths()).toEqual(['PUT /api/goals/goal-1/definitions/1']);
  });

  it('an open approval confirmation is dropped when a refresh shows a different persisted hash', async () => {
    const world: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 1 }, null, null),
      defs: [proposed(1)],
    };
    const user = await openDefinitions(world);
    await screen.findByLabelText('Definition JSON');
    await user.click(screen.getByRole('button', { name: /Approve definition v1/ }));
    await screen.findByRole('alertdialog', { name: 'Confirm approve definition' });
    world.defs = [proposed(1, { definitionHash: 'moved0000000' })];
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Confirm approve definition' })).toBeNull(),
    );
    expect(posts()).toEqual([]);
  });

  it('Reject confirms first, POSTs {} and neither abandons nor resumes', async () => {
    const world: World = {
      goal: goalWith('draft', { kind: 'approve_definition', version: 2 }, 'user_revision', 1),
      defs: [definitionFull(1), proposed(2)],
    };
    const user = await openDefinitions(world, {
      'POST /api/goals/goal-1/definitions/2/reject': () => {
        world.goal = goalWith('ready', { kind: 'start' }, 'amendment_discarded', 1);
        world.defs = [
          definitionFull(1),
          definitionFull(2, { status: 'rejected', approvedAt: null, approvedBy: null }),
        ];
        return { version: 2, goalStatus: 'ready' };
      },
    });
    await screen.findByLabelText('Definition JSON');
    await user.click(screen.getByRole('button', { name: 'Reject proposed definition' }));
    expect(posts()).toEqual([]);
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm reject definition' });
    expect(dialog.textContent).toContain('does not delete or abandon the Goal');
    await user.click(within(dialog).getByRole('button', { name: 'Reject proposal' }));
    await waitFor(() => expect(paths()).toEqual(['POST /api/goals/goal-1/definitions/2/reject']));
    expect(posts()[0]!.body).toEqual({});
    await waitFor(() => expect(screen.queryByLabelText('Definition JSON')).toBeNull());
    expect(paths().some((p) => p.includes('abandon') || p.includes('resume'))).toBe(false);
  });

  it('rejecting an executing amendment leaves the Goal waiting and says so', async () => {
    const world: World = {
      goal: goalWith('needs_user', { kind: 'approve_definition', version: 2 }, 'amendment_in_progress', 1),
      defs: [definitionFull(1), proposed(2)],
    };
    const user = await openDefinitions(world, {
      'POST /api/goals/goal-1/definitions/2/reject': () => {
        world.goal = goalWith(
          'needs_user',
          { kind: 'resume_after_amendment', resolved: ['amendment_discarded'] },
          'amendment_in_progress',
          1,
        );
        world.defs = [
          definitionFull(1),
          definitionFull(2, { status: 'rejected', approvedAt: null, approvedBy: null }),
        ];
        return { version: 2, goalStatus: 'needs_user' };
      },
    });
    await screen.findByLabelText('Definition JSON');
    await user.click(screen.getByRole('button', { name: 'Reject proposed definition' }));
    expect(
      (await screen.findByRole('alertdialog', { name: 'Confirm reject definition' })).textContent,
    ).toContain('until you explicitly resume');
    await user.click(screen.getByRole('button', { name: 'Reject proposal' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resume after discarded amendment' })).toBeTruthy(),
    );
    expect(paths()).toEqual(['POST /api/goals/goal-1/definitions/2/reject']);
  });
});

describe('Revision, amendment and resume (7B.2B)', () => {
  const beginRoute = (after: () => void): Routes => ({
    'POST /api/goals/goal-1/definitions': () => {
      after();
      return { version: 2, definitionHash: 'n', validation: { valid: true, errors: [], warnings: [] } };
    },
  });

  it('ready Goal: Revise confirms, POSTs only a summary, and the refreshed Goal shows an editable proposal', async () => {
    const world: World = { goal: goalWith('ready', { kind: 'start' }), defs: [definitionFull(1)] };
    const user = await openDefinitions(
      world,
      beginRoute(() => {
        world.goal = goalWith('draft', { kind: 'approve_definition', version: 2 }, 'user_revision', 1);
        world.defs = [definitionFull(1), proposed(2)];
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Revise Goal' }));
    expect(posts()).toEqual([]);
    expect(
      (await screen.findByRole('alertdialog', { name: 'Confirm begin revision' })).textContent,
    ).toContain('returns to draft');
    await user.type(screen.getByLabelText('Change summary (optional)'), 'more');
    await user.click(screen.getByRole('button', { name: 'Begin revision' }));
    await screen.findByLabelText('Edit proposed definition v2');
    expect(paths()).toEqual(['POST /api/goals/goal-1/definitions']);
    expect(posts()[0]!.body).toEqual({ changeSummary: 'more' });
    expect(
      screen.getByText(
        (_, node) => node?.tagName === 'SUMMARY' && /^Compare with v1/.test(node.textContent ?? ''),
      ),
    ).toBeTruthy();
  });

  it.each([['running'], ['paused'], ['blocked']] as const)(
    '%s Goal: Begin amendment sends an empty body and the server decides',
    async (status) => {
      const world: World = {
        goal: goalWith(
          status,
          status === 'blocked' ? { kind: 'resolve_blocker', reasonCode: 'x' } : { kind: 'wait_for_turing' },
          status === 'blocked' ? 'x' : null,
        ),
        defs: [definitionFull(1)],
      };
      const user = await openDefinitions(
        world,
        beginRoute(() => {
          world.goal = goalWith(
            'needs_user',
            { kind: 'approve_definition', version: 2 },
            'amendment_in_progress',
          );
          world.defs = [definitionFull(1), proposed(2)];
        }),
      );
      await user.click(await screen.findByRole('button', { name: 'Revise Goal' }));
      expect(
        (await screen.findByRole('alertdialog', { name: 'Confirm begin revision' })).textContent,
      ).toContain('nothing resumes automatically');
      await user.click(screen.getByRole('button', { name: 'Begin amendment' }));
      await screen.findByLabelText('Edit proposed definition v2');
      expect(posts()[0]!.body).toEqual({});
      expect(paths()).toEqual(['POST /api/goals/goal-1/definitions']);
    },
  );

  it('scope violation and a denied gate (revise_goal) offer Revise; the server refusal gate_denial_not_settled is plain and repairs nothing', async () => {
    const scope: World = {
      goal: goalWith(
        'needs_user',
        { kind: 'resolve_blocker', reasonCode: 'scope_violation' },
        'scope_violation',
      ),
      defs: [definitionFull(1)],
    };
    await openDefinitions(scope);
    expect(await screen.findByRole('button', { name: 'Revise Goal' })).toBeTruthy();
    cleanup();

    const denied: World = {
      goal: goalWith('needs_user', { kind: 'revise_goal' }, 'gate_pending'),
      defs: [definitionFull(1)],
    };
    const user = await openDefinitions(denied, {
      'POST /api/goals/goal-1/definitions': () =>
        refuse(409, 'The denial is not settled.', 'gate_denial_not_settled'),
    });
    await user.click(await screen.findByRole('button', { name: 'Revise Goal' }));
    await user.click(await screen.findByRole('button', { name: 'Begin amendment' }));
    const alert = await screen.findByText(/Turing is still settling the denied gate. Retry shortly./);
    expect(alert.closest('[data-refusal-code]')!.getAttribute('data-refusal-code')).toBe(
      'gate_denial_not_settled',
    );
    expect(paths()).toEqual(['POST /api/goals/goal-1/definitions']);
  });

  it('manual reconciliation shows history only: no edit, approve, reject or revise', async () => {
    const world: World = {
      goal: goalWith('blocked', { kind: 'manual_reconciliation' }, 'git_state_invalid'),
      defs: [definitionFull(1), proposed(2)],
    };
    await openDefinitions(world);
    await screen.findByLabelText('Definition v1');
    expect(
      screen.queryByRole('button', { name: /Revise Goal|Approve definition|Reject proposed|Save proposed/ }),
    ).toBeNull();
    expect(screen.queryByLabelText('Definition JSON')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('terminal Goals offer no definition authority', async () => {
    const world: World = { goal: goalWith('completed', { kind: 'completed' }), defs: [definitionFull(1)] };
    await openDefinitions(world);
    await screen.findByLabelText('Definition v1');
    expect(screen.queryByRole('button', { name: /Revise Goal/ })).toBeNull();
  });

  it('a Goal with no definition says plainly that this version cannot author one', async () => {
    const world: World = { goal: goalWith('draft', { kind: 'author_definition' }, null, null), defs: [] };
    await openDefinitions(world);
    expect(await screen.findByText(/cannot author one from this screen/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Author|Generate/ })).toBeNull();
  });

  it.each([
    ['amendment_approved', 'Resume after approved amendment'],
    ['amendment_discarded', 'Resume after discarded amendment'],
  ] as const)(
    'resume after %s sends exactly that reason once, after the server states the outcome',
    async (reason, label) => {
      const world: World = {
        goal: goalWith(
          'needs_user',
          { kind: 'resume_after_amendment', resolved: [reason] },
          'amendment_in_progress',
        ),
        defs: [definitionFull(1)],
      };
      serve(
        routesFor(world, { 'POST /api/goals/goal-1/resume': () => ({ ok: true, goalStatus: 'running' }) }),
      );
      const user = userEvent.setup();
      render(<GoalsPage projects={PROJECTS} />);
      await openGoal(user);
      await user.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(paths()).toEqual(['POST /api/goals/goal-1/resume']);
      expect(posts()[0]!.body).toEqual({ reason });
    },
  );

  it('offers no resume when the server proves no amendment outcome yet, and shows a supervisor refusal', async () => {
    const none: World = {
      goal: goalWith('needs_user', { kind: 'resume_after_amendment', resolved: [] }, 'amendment_in_progress'),
      defs: [definitionFull(1)],
    };
    serve(routesFor(none));
    const user = userEvent.setup();
    render(<GoalsPage projects={PROJECTS} />);
    await openGoal(user);
    await screen.findByLabelText('Next action');
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
    cleanup();

    const world: World = {
      goal: goalWith(
        'needs_user',
        { kind: 'resume_after_amendment', resolved: ['amendment_approved'] },
        'amendment_in_progress',
      ),
      defs: [definitionFull(1)],
    };
    serve(
      routesFor(world, {
        'POST /api/goals/goal-1/resume': () =>
          refuse(409, 'The Goal cannot proceed: amendment_not_resolved.', 'amendment_not_resolved', {
            ok: false,
          }),
      }),
    );
    const again = userEvent.setup();
    render(<GoalsPage projects={PROJECTS} />);
    await openGoal(again);
    await again.click(await screen.findByRole('button', { name: 'Resume after approved amendment' }));
    const alert = await screen.findByText(/Not done:/);
    expect(alert.textContent).toContain('Amendment not resolved');
    expect(paths()).toEqual(['POST /api/goals/goal-1/resume']);
    expect(gets('/api/goals/goal-1')).toBeGreaterThan(1);
  });
});
