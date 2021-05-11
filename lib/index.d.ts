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
declare type Affinity = 0 | 1 | 2;
/** Interface available both in the main thread and workers. */
export interface ITaskPool<T> {
    addTask(arg: T, options?: TaskOptions): void;
}
/** Task processing entrypoint. */
export declare type ProcessFunc<T, U> = (arg: T, pool: ITaskPool<T>) => U | Promise<U>;
/** Options that can be passed when adding a task. */
export interface TaskOptions {
    /** Prefer running on that specific worker. This is implicitely set when
     * adding a task from within a worker.
     */
    workerAffinity?: 'main' | number;
    /** How much effort should be put into respecting workerAffinity.
     * - 0 (or unset): The work can be stolen without hesitation.
     * - 1 The work might be stolen under certain circumstances.
     * - 2 The work will never be stolen under any circumstances.
     *
     * force is always implied when the affinity is 'main'
     */
    affinityStrength?: Affinity;
}
export interface IWorker {
    readonly id: string;
}
/** A task that has been added to the worker pool. */
export interface Task<T, U> extends PromiseLike<U> {
    readonly arg: T;
    readonly id: string;
    readonly options: TaskOptions;
    readonly worker?: IWorker;
}
/** Options that can be passed to a worker pool at construction. */
export interface WorkerPoolOptions<T, U> {
    /** Name of the exported symbol to use in the entrypoint module. Default: 'processTask' */
    entrypointSymbol: string;
    /** New workers are launched when the ratio of pending tasks to workers goes above this threshold. Default: 3 */
    taskPerWorker: number;
    /** Absolute maximum number of workers to launch. Default: cpu count */
    maxWorkers: number;
    /** How many tasks can be queued in each worker's backends. Lower = better load balancing. Higher = better pipelining. Default: 2.*/
    workerConcurency: number;
    /** Task processing's entrypoint function. (useful for type inference) */
    entryPoint?: ProcessFunc<T, U>;
}
/** A pool of worker threads dedicated to processing tasks of the (T)=>U form. */
export interface WorkerPool<T, U> {
    readonly isIdle: boolean;
    addTask(arg: T, options?: TaskOptions): Task<T, U>;
    on(event: 'task-added', listener: (task: Task<T, U>) => void): this;
    on(event: 'task-complete', listener: (err: Error | undefined, result: U | undefined, task: Task<T, U>) => void): this;
    dispose(): void;
    whenIdle(): Promise<void>;
}
export interface WorkerPoolConstructor {
    new <T, U>(entrypointModule: string, opts?: Partial<WorkerPoolOptions<T, U>>): WorkerPool<T, U>;
}
export declare const WorkerPool: WorkerPoolConstructor;
export {};
