import type { SpindleAPI } from 'lumiverse-spindle-types';
import { api, varsLog } from './common';
import type { SetvarKind } from './parsers/setvar';

// Shared routing for setvar/setchatvar/setgvar/setglobalvar. Used by
// applyAndStripSetvars (widget `{{setvar::...}}` macros), the user-typed
// `/setvar` message processor, and the iframe pushToSillyTavern dispatch.
//
// setgvar/setglobalvar are DISABLED this iteration: api.variables.global.set
// writes to settings.macro_variables_global but {{getgvar}} reads from
// chat.metadata.macro_variables.global (MacroEnv.ts:105). The set is invisible
// to subsequent resolves. Re-enable when upstream unifies the read/write paths.

export type VarsApi = Pick<SpindleAPI['variables'], 'local' | 'chat' | 'global'>;

export interface SetvarOp {
  kind: SetvarKind;
  name: string;
  value: string;
}

// Returns true if the op was applied (caller should strip the match from the
// template / mark as handled), false if it was intentionally skipped (gvar
// disabled — caller should leave the match in place).
export async function applySetvarOp(
  op: SetvarOp,
  chatId: string,
  userId: string,
  vars: VarsApi = api.variables,
): Promise<boolean> {
  // ST's setvar writes the chat variables, like setchatvar.
  if (op.kind === 'setvar' || op.kind === 'setchatvar') {
    await vars.chat.set(chatId, op.name, op.value);
    return true;
  }
  // setgvar / setglobalvar — disabled, see header comment.
  varsLog.debug(`skipping ${op.kind} (upstream get/set path split):`, { name: op.name, userId });
  return false;
}
