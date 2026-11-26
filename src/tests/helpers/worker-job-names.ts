import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  INSTAGRAM_DATABASE_TASK_QUEUE,
  INSTAGRAM_META_TASK_QUEUE,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.processor.js';
import { getScheduledJobs } from '@/infrastructure/queue/scheduler.js';
import { createWorkerContainers } from '@/worker-containers.js';

const SOURCE_ROOT = join(process.cwd(), 'src');

/** A job-name expression in a queue file that no source constant resolves (a parameter). */
export interface UnresolvedJobNameExpression {
  file: string;
  queueName: string;
  expression: string;
}

/** Every job name the code puts on each queue, and the add calls it could not read. */
export interface WorkerJobNamesFromCode {
  jobNamesByQueue: ReadonlyMap<string, ReadonlySet<string>>;
  unresolved: readonly UnresolvedJobNameExpression[];
}

interface SourceFile {
  path: string;
  text: string;
}

function readSourceFiles(directory: string = SOURCE_ROOT, files: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__' || entry === 'tests') continue;
      readSourceFiles(fullPath, files);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      files.push({ path: relative(process.cwd(), fullPath), text: readFileSync(fullPath, 'utf8') });
    }
  }
  return files;
}

/** `const NAME = 'value'` (exported or not, possibly wrapped onto the next line). */
const STRING_CONSTANT = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*'([^']*)'/g;
/** `const NAME = { key: 'value', … }` — a job-name map such as the intake kinds'. */
const OBJECT_CONSTANT = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([^}]*)\}/g;
/** `new Queue(NAME` or `new Queue<Data>(\n  NAME` — a queue file names its queue by a constant. */
const QUEUE_CONSTRUCTION = /new Queue(?:<[^>]*>)?\(\s*([A-Z][A-Z0-9_]*)/;
/** The first argument of `.add(` — the job name. */
const ADD_CALL = /\.add\(\s*([^,]+?)\s*,/g;
/**
 * `name: <constant or literal>` — the job name of one `addBulk` entry (a lowercase value there is a
 * type annotation, such as the mail tags' `name: string`).
 */
const BULK_ENTRY_NAME = /\bname:\s*([A-Z][A-Z0-9_]*(?:\[[^\]]*\])?|'[^']*')/g;
/** `job.name === <constant>` — a worker routing one job name to its own branch. */
const ROUTING_COMPARISON = /\bjob\.name\s*===\s*([A-Z][A-Z0-9_]*)/g;
/** A queue-name constant a worker file names. */
const QUEUE_NAME_CONSTANT = /\b[A-Z][A-Z0-9_]*_QUEUE_NAME\b/g;

/** The first capture group of every match of `pattern` (a global regular expression) in `text`. */
function firstGroups({ text, pattern }: { text: string; pattern: RegExp }): string[] {
  return [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** The first two capture groups of every match of `pattern` in `text`. */
function groupPairs({ text, pattern }: { text: string; pattern: RegExp }): [string, string][] {
  return [...text.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined || match[2] === undefined
      ? []
      : [[match[1], match[2]] as [string, string]],
  );
}

function collectConstants(files: readonly SourceFile[]): {
  strings: Map<string, string>;
  objects: Map<string, string[]>;
} {
  const strings = new Map<string, string>();
  const objects = new Map<string, string[]>();
  for (const { text } of files) {
    for (const [name, value] of groupPairs({ text, pattern: STRING_CONSTANT })) {
      strings.set(name, value);
    }
    for (const [name, body] of groupPairs({ text, pattern: OBJECT_CONSTANT })) {
      objects.set(name, firstGroups({ text: body, pattern: /'([^']*)'/g }));
    }
  }
  return { strings, objects };
}

/** The job names one expression names: a literal, a string constant, or every value of a map. */
function resolveJobNameExpression({
  expression,
  strings,
  objects,
}: {
  expression: string;
  strings: ReadonlyMap<string, string>;
  objects: ReadonlyMap<string, readonly string[]>;
}): readonly string[] | null {
  const literal = /^'([^']*)'$/.exec(expression)?.[1];
  if (literal !== undefined) return [literal];
  const constant = strings.get(expression);
  if (constant !== undefined) return [constant];
  const mapName = /^([A-Z][A-Z0-9_]*)\[/.exec(expression)?.[1];
  if (mapName !== undefined) return objects.get(mapName) ?? null;
  return null;
}

function addJobName({
  jobNamesByQueue,
  queueName,
  jobName,
}: {
  jobNamesByQueue: Map<string, Set<string>>;
  queueName: string;
  jobName: string;
}): void {
  const names = jobNamesByQueue.get(queueName) ?? new Set<string>();
  names.add(jobName);
  jobNamesByQueue.set(queueName, names);
}

/**
 * The job names a worker file routes by `job.name === <constant>`, on the one queue the file names
 * (a file routing jobs while naming several queues is reported unresolved).
 */
function collectRoutedJobNames({
  file,
  strings,
  jobNamesByQueue,
  unresolved,
}: {
  file: SourceFile;
  strings: ReadonlyMap<string, string>;
  jobNamesByQueue: Map<string, Set<string>>;
  unresolved: UnresolvedJobNameExpression[];
}): void {
  const routed = firstGroups({ text: file.text, pattern: ROUTING_COMPARISON });
  if (routed.length === 0) return;
  const queueConstants = [...new Set(file.text.match(QUEUE_NAME_CONSTANT) ?? [])];
  const onlyQueueConstant = queueConstants.length === 1 ? queueConstants[0] : undefined;
  const queueName = onlyQueueConstant === undefined ? undefined : strings.get(onlyQueueConstant);
  for (const constant of routed) {
    const jobName = strings.get(constant);
    if (queueName === undefined || jobName === undefined) {
      unresolved.push({ file: file.path, queueName: queueName ?? '?', expression: constant });
      continue;
    }
    addJobName({ jobNamesByQueue, queueName, jobName });
  }
}

/**
 * Every job name each queue's processor is handed, read from the code itself (change-plan-gates
 * JGC3) — never a hand list.
 *
 * @remarks
 * - **Algorithm:** the union of four readings: (1) the scheduler's
 *   repeatable jobs (`getScheduledJobs()`, run as code); (2) every enqueue: each non-test source
 *   file that builds `new Queue(<QUEUE_NAME>)` — the first argument of each `.add(` and the `name:`
 *   of each `addBulk` entry, resolved through the source's string constants (a literal, a constant,
 *   or every value of a job-name map); (3) the Instagram task handlers the worker composition root
 *   registers (`createWorkerContainers()`), on the task queue whose `callsMeta` matches the
 *   handler's — the task processor runs a job by its handler, so the handler map is its job list;
 *   (4) every `job.name === <constant>` a worker file routes, on the one queue that file names —
 *   a branch for a job nothing schedules today (the seat reconcile while the seat sync is off).
 * - **Failure modes:** an add whose job name is a parameter is returned in `unresolved`; the
 *   coverage test accepts it only on the two task queues, whose names come from (3).
 * - **Notes:** the composition root builds services only — no database or Redis connection.
 */
export function listWorkerJobNamesFromCode(): WorkerJobNamesFromCode {
  const files = readSourceFiles();
  const { strings, objects } = collectConstants(files);
  const jobNamesByQueue = new Map<string, Set<string>>();
  const unresolved: UnresolvedJobNameExpression[] = [];

  for (const job of getScheduledJobs()) {
    addJobName({ jobNamesByQueue, queueName: job.queueName, jobName: job.jobName });
  }

  for (const file of files) {
    collectRoutedJobNames({ file, strings, jobNamesByQueue, unresolved });
    const queueConstant = QUEUE_CONSTRUCTION.exec(file.text)?.[1];
    if (queueConstant === undefined) continue;
    const queueName = strings.get(queueConstant);
    if (queueName === undefined) continue;
    const expressions = [
      ...firstGroups({ text: file.text, pattern: ADD_CALL }),
      ...firstGroups({ text: file.text, pattern: BULK_ENTRY_NAME }),
    ].map((expression) => expression.trim());
    for (const expression of expressions) {
      const jobNames = resolveJobNameExpression({ expression, strings, objects });
      if (jobNames === null) {
        unresolved.push({ file: file.path, queueName, expression });
        continue;
      }
      for (const jobName of jobNames) addJobName({ jobNamesByQueue, queueName, jobName });
    }
  }

  const { taskHandlers } = createWorkerContainers().appDomain.instagramSendWork;
  for (const [jobName, handler] of Object.entries(taskHandlers)) {
    const queue = handler.callsMeta ? INSTAGRAM_META_TASK_QUEUE : INSTAGRAM_DATABASE_TASK_QUEUE;
    addJobName({ jobNamesByQueue, queueName: queue.queueName, jobName });
  }

  return { jobNamesByQueue, unresolved };
}
