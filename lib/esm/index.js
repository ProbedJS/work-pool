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
import { ADD_TASK_TYPE, EXIT_TYPE, READY_TYPE, TASK_COMPLETION_TYPE, } from './worker.js';
import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import os from 'os';
import { Worker } from 'worker_threads';
import workerModule from './worker-location.js';
/** A flat amount added to all tasks.  */
const BASE_TASK_COST = 1;
const MAIN_THREAD_ID = -1;
const WORKER_STARTING = 0;
const WORKER_READY = 1;
const WORKER_DISPOSED = 2;
class ClientBase {
    constructor(load) {
        this.load = load;
    }
    postMessageToWorker(_type, _contents) {
        // Intentionally empty
    }
    dispose() {
        // Intentionally empty
    }
    _shouldAdvance() {
        return this._next.load !== -1 && this.load > this._next.load;
    }
    _shouldRetreat() {
        return this._prev.load !== -1 && this.load < this._prev.load;
    }
    _resort() {
        if (this._shouldAdvance()) {
            // Yank out the node.
            this._next._prev = this._prev;
            this._prev._next = this._next;
            // Advance until we find where we belong.
            this._next = this._next._next;
            while (this._shouldAdvance()) {
                this._next = this._next._next;
            }
            // Insert ourselves.
            this._prev = this._next._prev;
            this._next._prev = this;
            this._prev._next = this;
        }
        else if (this._shouldRetreat()) {
            this._prev._next = this._next;
            this._next._prev = this._prev;
            while (this._shouldRetreat()) {
                this._prev = this._prev._prev;
            }
            this._next = this._prev._next;
            this._next._prev = this;
            this._prev._next = this;
        }
    }
}
class Client extends ClientBase {
    constructor(pool, options, id) {
        super(0);
        this.ownedTasks = 0;
        this.tasksDispatched = 0;
        this.status = WORKER_STARTING;
        this._queue = [];
        this.id = id;
        this._options = options;
        this._pool = pool;
    }
    dispose() {
        this.status = WORKER_DISPOSED;
    }
    _ready() {
        this.status = WORKER_READY;
        this._flush();
    }
    _complete(msg) {
        const task = this._pool._tasks.get(msg.id);
        this.ownedTasks -= 1;
        this.tasksDispatched -= 1;
        this.load -= task.taskCost + task.pretaskCost + BASE_TASK_COST;
        this._resort();
        task.taskCost = msg.taskCost;
        task.pretaskCost = msg.pretaskCost;
        this._pool._completed(task, msg.error, msg.result);
        this._flush();
    }
    _enqueue(task) {
        this.ownedTasks += 1;
        this.load += task.taskCost + task.pretaskCost + BASE_TASK_COST;
        this._resort();
        this._queue.push(task);
        this._flush();
    }
    _flush() {
        while (this.status === WORKER_READY &&
            this.tasksDispatched < this._options.maxConcurency) {
            const next = this._queue.shift();
            if (next) {
                this.tasksDispatched += 1;
                next.worker = this;
                const msg = {
                    id: next.id,
                    arg: next.argument,
                    options: next.options,
                };
                this._onAddTask(msg);
            }
            else {
                break;
            }
        }
    }
}
class WorkerClient extends Client {
    constructor(pool, port, options, id) {
        super(pool, options, id);
        this._port = port;
        port.on('message', (msg) => this._recv(msg));
    }
    dispose() {
        this._port.postMessage({ type: EXIT_TYPE });
        super.dispose();
    }
    postMessageToWorker(type, contents) {
        this._port.postMessage({ type, contents });
    }
    _recv(msg) {
        if (this.status === WORKER_DISPOSED)
            return;
        switch (msg.type) {
            case READY_TYPE:
                this._ready();
                break;
            case TASK_COMPLETION_TYPE:
                this._complete(msg);
                break;
            default:
                this._pool._recvMsg(msg, this);
                break;
        }
    }
    _onAddTask(msg) {
        this._port.postMessage({ type: ADD_TASK_TYPE, ...msg });
    }
}
class MainThreadClient extends Client {
    constructor(pool, options) {
        super(pool, options, MAIN_THREAD_ID);
        this._eventsEmmiter = new EventEmitter();
        this._next = this;
        this._prev = this;
        import(pool._entrypointModule).then(async (mod) => {
            this._entry = mod[pool._options.entrypointSymbol];
            if (this._entry.onWorkerStart) {
                await this._entry.onWorkerStart(this);
            }
            this._ready();
        });
    }
    onMessage(type, listener) {
        this._eventsEmmiter.on(type, listener);
    }
    postMessageToPool(type, contents) {
        const msg = { type, contents };
        this._pool._recvMsg(msg, this);
    }
    postMessageToWorker(type, contents) {
        this._recvMessageToWorker(type, contents);
    }
    _recvMessageToWorker(type, contents) {
        this._eventsEmmiter.emit(type, contents, this);
    }
    async _onAddTask(msg) {
        const { arg, options, id } = msg;
        let taskCost = 0;
        let pretaskCost = 0;
        if (this._entry.preTask) {
            const startTime = performance.now();
            await this._entry.preTask(arg, this);
            pretaskCost = performance.now() - startTime;
        }
        const startTime = performance.now();
        const rawResult = this._entry(arg, this);
        rawResult.then((result) => {
            taskCost = performance.now() - startTime;
            this._complete({ id, options, result, taskCost, pretaskCost });
        }, (error) => {
            taskCost = performance.now() - startTime;
            this._complete({ id, options, error, taskCost, pretaskCost });
        });
    }
}
/** A pool of workers capable of performing work. */
class WorkerPoolImpl {
    constructor(entrypointModule, opts) {
        this._eventsEmmiter = new EventEmitter();
        this._msgEventsEmmiter = new EventEmitter();
        this._numWorkers = 0;
        this._nextTaskId = 0;
        this._tasks = new Map();
        this._onNextIdle = [];
        this._costCache = new Map();
        this._entrypointModule = entrypointModule;
        this._options = {
            maxWorkers: os.cpus().length,
            inherentCostEstimator: () => 0,
            workerCostEstimator: () => 0,
            workerConcurency: 2,
            taskPerWorker: 3,
            entrypointSymbol: 'workerEntrypoint',
            ...opts,
        };
        const canaryNode = new ClientBase(-1);
        canaryNode._next = canaryNode;
        canaryNode._prev = canaryNode;
        this._workers = canaryNode;
        this._mainThreadWorker = new MainThreadClient(this, {
            maxConcurency: this._options.workerConcurency,
        });
    }
    /** Will only be true if all work queued and discovered so far has been completed. */
    get isIdle() {
        return this._tasks.size === 0;
    }
    on(event, listener) {
        this._eventsEmmiter.on(event, listener);
        return this;
    }
    removeListener(event, listener) {
        this._eventsEmmiter.removeListener(event, listener);
        return this;
    }
    onMessage(event, listener) {
        this._msgEventsEmmiter.on(event, listener);
        return this;
    }
    removeMessageListener(event, listener) {
        this._msgEventsEmmiter.removeListener(event, listener);
        return this;
    }
    /** Sends a message to all currently active workers. This does NOT wait for the task queue to be empty. */
    postMessageToWorkers(type, contents) {
        this._mainThreadWorker.postMessageToWorker(type, contents);
        let current = this._workers._next;
        while (current != this._workers) {
            current.postMessageToWorker(type, contents);
            current = current._next;
        }
    }
    /** Add a task to be performed. */
    addTask(arg, opts) {
        return this._registerTask(this._nextTaskId++, arg, opts || {});
    }
    _chooseWorker(task) {
        const workerEstimator = this._options.workerCostEstimator;
        let taskCost;
        if (task.options.key) {
            taskCost =
                this._costCache.get(task.options.key) ||
                    this._options.inherentCostEstimator(task);
        }
        else {
            taskCost = this._options.inherentCostEstimator(task);
        }
        let result = this._workers._next;
        let pretaskCost = workerEstimator(task, result);
        let resultNewLoad = result.load + taskCost + pretaskCost;
        // We know the following:
        // - inherentCost is fixed.
        // - result.load can only increase, or stay the same.
        // - workerCost can become literaly anything.
        while (result._next !== this._workers) {
            const candidate = result._next;
            const candidatePretaskCost = workerEstimator(task, candidate);
            const candidateNewLoad = candidate.load + taskCost + candidatePretaskCost;
            if (candidateNewLoad < resultNewLoad) {
                result = candidate;
                pretaskCost = candidatePretaskCost;
                resultNewLoad = candidateNewLoad;
            }
            else {
                // There might be a remaining worker who's estimate is better, but it
                // cannot possibly overcome the load difference.
                break;
            }
        }
        task.taskCost = taskCost;
        task.pretaskCost = pretaskCost;
        return result;
    }
    _registerTask(id, arg, options) {
        const newTask = new TaskImpl(id, options, arg);
        this._tasks.set(id, newTask);
        if (this._numWorkers < this._options.maxWorkers &&
            this._tasks.size - this._mainThreadWorker.ownedTasks >
                this._numWorkers * this._options.taskPerWorker) {
            this._launchWorker();
        }
        if (options.mainThread) {
            this._mainThreadWorker._enqueue(newTask);
            this._eventsEmmiter.emit('task-added', newTask);
            return newTask;
        }
        const worker = this._chooseWorker(newTask);
        worker._enqueue(newTask);
        this._eventsEmmiter.emit('task-added', newTask);
        return newTask;
    }
    _completed(task, error, result) {
        if (task.options.key) {
            this._costCache.set(task.options.key, task.taskCost);
        }
        if (error) {
            task._reject(error);
        }
        else {
            task._resolve(result);
        }
        this._tasks.delete(task.id);
        this._eventsEmmiter.emit('task-complete', error, result, task);
        if (this.isIdle) {
            this._onNextIdle.forEach((cb) => cb());
            this._onNextIdle = [];
        }
    }
    _recvMsg(msg, origin) {
        this._msgEventsEmmiter.emit(msg.type, msg.contents, origin);
    }
    dispose() {
        let current = this._workers._next;
        while (current != this._workers) {
            current.dispose();
            current = current._next;
        }
        this._mainThreadWorker.dispose();
    }
    /** Wait until the pool is not performing any work anymore. */
    whenIdle() {
        if (this.isIdle) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this._onNextIdle.push(resolve);
        });
    }
    _launchWorker() {
        const data = {
            entrypointModule: this._entrypointModule,
            entrypointSymbol: this._options.entrypointSymbol,
        };
        const newClient = new WorkerClient(this, new Worker(workerModule, { workerData: data }), { maxConcurency: this._options.workerConcurency }, this._numWorkers);
        this._numWorkers += 1;
        this._eventsEmmiter.emit('worker-launched', newClient);
        // A fresh worker has no load, so it can go straight to the front of the list,
        // no questions asked.
        newClient._next = this._workers._next;
        newClient._prev = this._workers;
        newClient._next._prev = newClient;
        newClient._prev._next = newClient;
    }
    resizeUpTo(upTo) {
        const workersToLaunch = Math.min(upTo, this._options.maxWorkers);
        while (this._numWorkers < workersToLaunch) {
            this._launchWorker();
        }
    }
}
class TaskImpl {
    constructor(id, options, arg) {
        this.taskCost = 0;
        this.pretaskCost = 0;
        this._prom = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
        this.id = id;
        this.argument = arg;
        this.options = options;
    }
    then(onfulfilled, onrejected) {
        return this._prom.then(onfulfilled, onrejected);
    }
}
export const WorkerPool = WorkerPoolImpl;
//# sourceMappingURL=index.js.map