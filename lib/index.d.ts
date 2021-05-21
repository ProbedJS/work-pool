/**
 * Copyright 2021 Francois Chabot
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
export declare type UserContent = any;
/** Interface available both in the main thread and workers. */
export interface IWorkerClient<T> {
    postMessageToPool(type: string, contents: UserContent): void;
    onMessage(type: string, handler: (contents: UserContent, client: IWorkerClient<T>) => void): void;
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
export interface IWorker {
    readonly id: number;
    postMessageToWorker(type: string, contents?: UserContent): void;
}
/** Worker entrypoint */
export interface WorkerEntryPoint<T, U> {
    (arg: T, client: IWorkerClient<T>): Promise<U>;
    /** Work performed here will count as worker overhead, and NOT as intrinsic cost. */
    preTask?: (arg: T, client: IWorkerClient<T>) => void;
    onWorkerStart?: (client: IWorkerClient<T>) => void | Promise<void>;
    onWorkerExit?: (client: IWorkerClient<T>) => void | Promise<void>;
}
/** A task that has been added to the worker pool. */
export interface Task<T, U> extends PromiseLike<U> {
    readonly argument: T;
    readonly id: number;
    readonly options: TaskOptions;
    readonly worker?: IWorker;
    readonly taskCost: number;
    readonly pretaskCost: number;
}
/** Options that can be passed to a worker pool at construction. */
export interface WorkerPoolOptions<T, U> {
    /** Name of the exported symbol to use in the entrypoint module. Default: 'workerEntrypoint' */
    entrypointSymbol: string;
    /** New workers are launched when the ratio of pending tasks to workers goes above this threshold. Default: 3 */
    taskPerWorker: number;
    /** Absolute maximum number of workers to launch. Default: cpu count */
    maxWorkers: number;
    /** How many tasks can be sent at a time to each worker. Lower -> better load balancing. Higher -> better pipelining. Default: 2.*/
    workerConcurency: number;
    /** Function that returns an estimate of the cost (in ms) associated with running a task on a given worker.*/
    inherentCostEstimator: (task: Task<T, U>) => number;
    workerCostEstimator: (task: Task<T, U>, worker: IWorker) => number;
    /** Task processing's entrypoint function. */
    entryPoint?: WorkerEntryPoint<T, U>;
}
/** A pool of worker threads dedicated to processing tasks of the (T)=>U form. */
export interface WorkerPool<T, U> {
    /** Wether or not there is work currently queued and/or being processed. */
    readonly isIdle: boolean;
    /** Add a task to be processed. There is no guarantee that tasks will be executed in order.*/
    addTask(arg: T, options?: TaskOptions): Task<T, U>;
    /** Register a handler that is called whenever a task is added to the pool. */
    on(event: 'task-added', listener: (task: Task<T, U>) => void): this;
    on(event: 'worker-launched', listener: (worker: IWorker) => void): this;
    /** Register a handler that is called whenever a task is done. */
    on(event: 'task-complete', listener: (err: Error | undefined, result: U | undefined, task: Task<T, U>) => void): this;
    removeListener(event: 'task-added', listener: (task: Task<T, U>) => void): this;
    removeListener(event: 'worker-launched', listener: (worker: IWorker) => void): this;
    removeListener(event: 'task-complete', listener: (err: Error | undefined, result: U | undefined, task: Task<T, U>) => void): this;
    /** Register a handler that is called whenever a message with the provided type is sent from a worker. */
    onMessage(type: string, listener: (msg: UserContent, origin: IWorker) => void): this;
    removeMessageListener(event: string, listener: (...args: any[]) => void): this;
    /** Sends a message to every **current** worker. */
    postMessageToWorkers(type: string, contents?: UserContent): void;
    /** Clean up. */
    dispose(): void;
    /** Gets a promise that resolves when every queued task has been completed. */
    whenIdle(): Promise<void>;
    /** Increases the current number of launchers. */
    resizeUpTo(upTo: number): void;
}
export interface WorkerPoolConstructor {
    new <T, U>(entrypointModule: string, opts?: Partial<WorkerPoolOptions<T, U>>): WorkerPool<T, U>;
}
export declare const WorkerPool: WorkerPoolConstructor;
