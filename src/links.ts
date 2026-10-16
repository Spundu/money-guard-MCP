// Where a path's links lead, read before any is followed (SPEC.md §2.3 rule 2), and whether a path is inside
// a folder. Split from src/paths.ts, which grew past 400 lines (review round 20).

import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Whether `candidate` (absolute) is `root` or inside it. Works across drives and letter case on Windows. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/** Most links `leadsTo` follows one inside another, as the systems' own limits on a chain of links. */
export const MAX_LINK_HOPS = 64; // above Windows' 63 and Linux's 40: a chain realpath follows, this follows too

/**
 * Where `p` leads: its links followed one part at a time by what they say, as realpath does, but
 * without needing the end to exist (the parts from the first missing one stay as written). Null when
 * the links go round in a loop, nest more than MAX_LINK_HOPS deep, or the call has read MAX_LINK_PARTS
 * parts (a loop says nothing about what is outside). When realpath fails, this tells a link that leads
 * outside the project from a path that is missing inside it, so that through a link that leads outside,
 * a target that exists and one that does not get the same answer (review round 9). With `within`, it
 * stops where the path leaves that folder (neither inside it nor above it), before touching anything
 * there: a link to a share (\\host\share) or an automount (/net/host) is never opened (review round 19).
 */
export function leadsTo(p: string, within?: string, walk: LinkWalk = newLinkWalk()): string | null {
  const start = path.resolve(p);
  const top = path.parse(start).root;
  const led = walkParts(top, splitLink(start.slice(top.length)), within, walk, 0);
  if (led === null) return null;
  walk.parts += led.cost;
  return walk.parts > MAX_LINK_PARTS ? null : led.at;
}

/**
 * What one tool call has learned of the links on its paths: where each path it looked at leads (each link is
 * read once per call, so a chain of links shared by many entries costs one walk here), and how many parts of
 * link texts the system will have read to open them (realpath reads every link on a path again, each time).
 * Review round 20: a chain of 60 junctions held the server 63 s for 2,000 entries of files, and on Linux
 * realpath took 62 ms for each path through 30 links of "a/../" × 800; past MAX_LINK_PARTS the answer is
 * "too many links".
 */
export interface LinkWalk {
  follows: Map<string, Leads | 'following'>;
  parts: number;
}

/** Most parts of link texts one call has the system read: far above any project's, about 2.6 s of Linux's realpath. */
export const MAX_LINK_PARTS = 2_000_000;

export function newLinkWalk(): LinkWalk {
  return { follows: new Map(), parts: 0 };
}

/**
 * Where a path leads; `ended` when it stopped early (a part is missing, or it left `within`): the rest is as
 * written. `cost`: the parts of link texts read on the way, as the system reads them (again for each path). Null:
 * too many links.
 */
type Leads = { at: string; ended: boolean; cost: number } | null;

// A link's text is taken part by part, never tidied first: ".." goes up from where the links before
// it led, as Linux and macOS take it ("d/../x" through a link d to a folder outside is outside;
// path.resolve would have dropped "d/..", review round 10). Windows applies ".." in a symbolic link's
// text before following it; read this way, such a path only ends outside more often, never less.
function splitLink(text: string): string[] {
  return text.split(process.platform === 'win32' ? /[\\/]/ : '/').filter((part) => part !== '' && part !== '.');
}

function walkParts(from: string, parts: readonly string[], within: string | undefined, walk: LinkWalk, hops: number): Leads {
  let resolved = from;
  let cost = 0;
  for (const [i, part] of parts.entries()) {
    if (part === '..') {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, part);
    if (within !== undefined && !isInside(within, next) && !isInside(next, within)) return { at: path.join(next, ...parts.slice(i + 1)), ended: true, cost };
    const led = follow(next, within, walk, hops);
    if (led === null) return null;
    cost += led.cost;
    if (cost > MAX_LINK_PARTS) return null; // texts that name other links many times over
    if (led.ended) return { at: path.join(led.at, ...parts.slice(i + 1)), ended: true, cost };
    resolved = led.at;
  }
  return { at: resolved, ended: false, cost };
}

/** Where `next` (whose folder is already followed) leads: itself, or where its link leads. Remembered for the call. */
function follow(next: string, within: string | undefined, walk: LinkWalk, hops: number): Leads {
  const known = walk.follows.get(next);
  if (known === 'following') return null; // a loop: it leads through itself
  if (known !== undefined) return known;
  let link: string;
  try {
    if (!lstatSync(next).isSymbolicLink()) {
      walk.follows.set(next, { at: next, ended: false, cost: 0 });
      return { at: next, ended: false, cost: 0 };
    }
    link = readlinkSync(next).replace(/^\\\\\?\\/, ''); // a Windows junction's target may start with \\?\
  } catch {
    walk.follows.set(next, { at: next, ended: true, cost: 0 }); // missing: the rest is as written
    return { at: next, ended: true, cost: 0 };
  }
  if (hops >= MAX_LINK_HOPS) return null;
  walk.follows.set(next, 'following');
  // An absolute target starts again from its root; a relative one from the folder that holds the link.
  const top = path.isAbsolute(link) ? path.parse(link).root : path.dirname(next);
  const parts = splitLink(path.isAbsolute(link) ? link.slice(top.length) : link);
  const inner = walkParts(top, parts, within, walk, hops + 1);
  const led = inner === null ? null : { ...inner, cost: inner.cost + parts.length };
  walk.follows.set(next, led);
  return led;
}
