// Converts an effect's voice stack to/from its raw @liminal-hq/undertone builder-chain code,
// for the SFX editor's advanced "code view" (issue #153)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// This is purely an alternate authoring surface for the same VoiceParams[] the sliders already
// produce — codeToParams() never gets persisted itself, only its compiled output does, so no
// override (city or global) ever stores executable code. Evaluating the code via `new Function`
// runs in the page's own global scope (same as typing it into devtools), which is an acceptable
// trust boundary here: it's the player running JS against their own local browser session, not
// third-party code loaded from a shared/imported save.

import { note, sound, Voice, type VoiceParams } from '@liminal-hq/undertone';

// Rounds to 4 decimal places — well within the precision any slider in sfxEditor.ts's FIELDS
// can produce (their steps are 0.001/0.01/10), so this never loses anything a slider edit made.
// A value hand-typed in code view with finer precision (e.g. .gain(1/3)) will redisplay rounded
// the next time the textarea is regenerated — the saved draft itself keeps full precision, only
// the regenerated text is rounded.
function formatNumber(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

function voiceToCode(params: VoiceParams): string {
  const entry = params.pitch !== undefined
    ? `note(${JSON.stringify(params.pitch)})`
    : `sound(${JSON.stringify(params.soundType)})`;

  const calls = [
    `.sound(${JSON.stringify(params.soundType)})`,
    `.attack(${formatNumber(params.attack)})`,
    `.decay(${formatNumber(params.decay)})`,
    `.sustain(${formatNumber(params.sustain)})`,
    `.release(${formatNumber(params.release)})`,
    `.gain(${formatNumber(params.gainLevel)})`
  ];

  // filterCutoff undefined means "no filter at all" (see sfxEditor.ts's FIELDS comment) — the
  // envelope-timing calls are meaningless without a filter, so all six are omitted together.
  // Note: this is distinct from a filterCutoff of exactly 0, which .lpf(0) reproduces literally
  // (a real, near-silent 0Hz filter) rather than collapsing to "no filter" the way the filter
  // cutoff slider's own sentinel does — an edge case only reachable by typing .lpf(0) directly.
  if (params.filterCutoff !== undefined) {
    calls.push(
      `.lpf(${formatNumber(params.filterCutoff)})`,
      `.lpenv(${formatNumber(params.filterEnvAmount)})`,
      `.lpa(${formatNumber(params.filterAttack)})`,
      `.lpd(${formatNumber(params.filterDecay)})`,
      `.lps(${formatNumber(params.filterSustain)})`,
      `.lpr(${formatNumber(params.filterRelease)})`
    );
  }

  if (params.slideTime !== 0) calls.push(`.slide(${formatNumber(params.slideTime)})`);
  if (params.nudgeTime !== 0) calls.push(`.nudge(${formatNumber(params.nudgeTime)})`);

  return `${entry}\n    ${calls.join('\n    ')}`;
}

/** Serializes a voice stack as a JS array literal of note()/sound() builder chains. */
export function paramsToCode(paramsArray: VoiceParams[]): string {
  return `[\n  ${paramsArray.map(voiceToCode).join(',\n  ')}\n]`;
}

/**
 * Compiles code (expected to be a single expression evaluating to an array of Voice builder
 * chains) back into VoiceParams[]. Throws a descriptive Error on any failure — bad syntax, the
 * wrong shape, or a non-Voice element — so the caller can show it inline without crashing.
 */
export function codeToParams(code: string): VoiceParams[] {
  // A trailing semicolon is the single most natural thing to type after an array literal —
  // tolerate it (and surrounding whitespace) rather than making players discover the hard way
  // that this must be one bare expression, not a statement.
  const expression = code.trim().replace(/;\s*$/, '');
  let result: unknown;
  try {
    // eslint-disable-next-line no-new-func -- see file header: local-only, same trust boundary as devtools.
    const evaluate = new Function('note', 'sound', `'use strict'; return (\n${expression}\n);`);
    result = evaluate(note, sound);
  } catch (err) {
    throw new Error(`Couldn't parse code: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('Code must evaluate to a non-empty array of voices, e.g. [note(60).attack(0.01)...]');
  }

  return result.map((voice, i) => {
    if (!(voice instanceof Voice)) {
      throw new Error(`Item ${i + 1} isn't a voice — start each entry with note(...) or sound(...)`);
    }
    return { ...voice.getParams() };
  });
}
