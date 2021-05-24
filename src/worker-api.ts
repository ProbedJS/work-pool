export const TASK_COMPLETION_TYPE = '__completion';
export const READY_TYPE = '__ready';
export const ADD_TASK_TYPE = '__add';
export const EXIT_TYPE = '__exit';

export interface MsgBase {
  type: string;
}

export interface TaskCompletion<U> {
  id: number;
  options: TaskOptions;

  error?: Error;
  result?: U;

  taskCost: number;
  pretaskCost: number;
}

export interface AddTaskMsg<T> {
  id: number;
  options: TaskOptions;

  arg: T;
}

export interface MsgMsg extends MsgBase {
  contents: UserContent;
}

export interface WorkerConfig {
  entrypointModule: string;
  entrypointSymbol: string;
}

/** Options that can be passed when adding a task. */
export interface TaskOptions {
  /** If set, the task will run on the main thread. */
  mainThread?: boolean;

  /** A deterministic identifier for that task. Leads to better task dispatching over multiple runs. */
  key?: string;

  /** Addition info tagged onto the task. */
  meta?: UserContent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UserContent = any;

/** Interface available both in the main thread and workers. */
export interface IWorkerClient<T> {
  postMessageToPool(type: string, contents: UserContent): void;
  onMessage(
    type: string,
    handler: (contents: UserContent, client: IWorkerClient<T>) => void
  ): void;
}

export interface WorkerEntryPoint<T, U> {
  (arg: T, client: IWorkerClient<T>): Promise<U>;

  /** Work performed here will count as worker overhead, and NOT as intrinsic cost. */
  preTask?: (arg: T, client: IWorkerClient<T>) => void;

  onWorkerStart?: (client: IWorkerClient<T>) => void | Promise<void>;
  onWorkerExit?: (client: IWorkerClient<T>) => void | Promise<void>;

  modulePath: string;
  moduleSymbol: string;
}
