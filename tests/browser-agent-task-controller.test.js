import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskController } from '../browser-agent-extension/task-controller.js';

test('supervised tasks require confirmation before each action', () => {
  const task = createTaskController();
  assert.equal(task.state, 'running_supervised');
  assert.equal(task.canRun({}), false);
  assert.equal(task.confirmNext(), true);
  assert.equal(task.begin({ confirmed: true }), true);
  task.finishStep();
  assert.equal(task.state, 'running_supervised');
  assert.equal(task.begin({ confirmed: true }), false);
});

test('explicit auto mode runs steps, but stop blocks subsequent actions', () => {
  const task = createTaskController({ autoRequested: true });
  assert.equal(task.canRun({}), true);
  assert.equal(task.begin({}), true);
  assert.equal(task.stop(), 'running_auto');
  task.finishStep();
  assert.equal(task.state, 'stopped');
  assert.equal(task.canRun({}), false);
});

test('resume returns to confirmation mode, not unattended mode', () => {
  const task = createTaskController({ autoRequested: true });
  task.stop();
  assert.equal(task.state, 'stopped');
  assert.equal(task.resume(), true);
  assert.equal(task.state, 'awaiting_confirmation');
  assert.equal(task.canRun({}), false);
  assert.equal(task.confirmNext(), true);
  assert.equal(task.begin({ confirmed: true }), true);
});

test('cannot start overlapping actions or complete while one is in flight', () => {
  const task = createTaskController({ autoRequested: true });
  assert.equal(task.begin({}), true);
  assert.equal(task.begin({}), false);
  assert.equal(task.complete(), false);
  task.finishStep();
  assert.equal(task.complete(), true);
  assert.equal(task.state, 'completed');
});
