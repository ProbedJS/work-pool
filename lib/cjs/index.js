"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerPool = void 0;
const worker_js_1 = require("./worker.js");
const events_1 = require("events");
const os_1 = __importDefault(require("os"));
const worker_threads_1 = require("worker_threads");
const worker_location_js_1 = __importDefault(require("./worker-location.js"));
const AFFINITY_LIGHT = 0;
const AFFINITY_STRONG = 1;
const AFFINITY_FORCE = 2;
const WORKER_STARTING = 0;
const WORKER_READY = 1;
const WORKER_DISPOSED = 2;
class WorkerClient {
    constructor(pool, port, options, id) {
        this.ownedTasks = 0;
        this.tasksDispatched = 0;
        this._queues = [[], [], []];
        this._activeTasks = {};
        this.status = WORKER_STARTING;
        this.id = id;
        this._options = options;
        this._port = port;
        this._pool = pool;
        port.on('message', (msg) => this._recv(msg));
    }
    dispose() {
        this.status = WORKER_DISPOSED;
        this._post({ type: 'exit' });
    }
    _recv(msg) {
        if (this.status === WORKER_DISPOSED)
            return;
        switch (msg.type) {
            case 'ready':
                this.status = WORKER_READY;
                this._flush();
                break;
            case 'task-complete':
                this._complete(msg);
                break;
            case 'task-failed':
                this._fail(msg);
                break;
            case 'task-discovered':
                this._discover(msg);
                break;
        }
    }
    _post(msg) {
        this._port.postMessage(msg);
    }
    _finish(id) {
        this.ownedTasks -= 1;
        this.tasksDispatched -= 1;
        const task = this._activeTasks[id];
        delete this._activeTasks[id];
        this._flush();
        return task;
    }
    _complete(msg) {
        const task = this._finish(msg.id);
        task.doresolve(msg.result);
        this._pool._completed(task, msg.result);
    }
    _fail(msg) {
        const task = this._finish(msg.id);
        task.doreject(msg.error);
        this._pool._failed(task, msg.error);
    }
    _discover(msg) {
        this._pool._registerTask(msg.id, msg.arg, msg.options);
    }
    _enqueue(task) {
        this.ownedTasks += 1;
        const qid = task.options.affinityStrength || 0;
        this._queues[qid].push(task);
        this._flush();
    }
    _flush() {
        while (this.status === WORKER_READY &&
            this.tasksDispatched < this._options.maxConcurency) {
            let next = this._queues[AFFINITY_FORCE].pop();
            if (next === undefined) {
                next = this._queues[AFFINITY_STRONG].pop();
            }
            if (next === undefined) {
                next = this._queues[AFFINITY_LIGHT].pop();
            }
            if (next === undefined && this._options.eager) {
                next = this._pool._findTask();
                if (next)
                    this.ownedTasks += 1;
            }
            if (next === undefined) {
                if (this.tasksDispatched === 0) {
                    this._pool._notifyIdle(this);
                }
                return;
            }
            this.tasksDispatched += 1;
            next.worker = this;
            this._activeTasks[next.id] = next;
            const msg = {
                type: 'add-task',
                id: next.id,
                options: next.options,
                arg: next.arg,
            };
            this._post(msg);
        }
    }
}
/** A pool of workers capable of performing work. */
class WorkerPoolImpl {
    constructor(entrypointModule, opts) {
        this._eventsEmmiter = new events_1.EventEmitter();
        /** Ordered by id */
        this._workers = [];
        /** No particular order */
        this._idleWorkers = [];
        // Pending tasks that have no particular worker affinity.
        this._freeTasks = [];
        this._nextTaskId = 0;
        this._ownedTasks = 0;
        this._onNextIdle = [];
        this._entrypointModule = entrypointModule;
        this._options = {
            maxWorkers: os_1.default.cpus().length,
            workerConcurency: 2,
            taskPerWorker: 3,
            entrypointSymbol: 'processTask',
            ...opts,
        };
        // If we exist, we'll need at least one worker...
        this._launchWorker();
        // And launch the main thread worker. This is a bit wasteful in many cases,
        // but doing this unconditionally removes a bunch of null checks.
        const { port1, port2 } = new worker_threads_1.MessageChannel();
        const mainWorkerCfg = {
            entrypointModule: this._entrypointModule,
            entrypointSymbol: this._options.entrypointSymbol,
            workerId: 'main',
        };
        new worker_js_1.TaskWorker(mainWorkerCfg, port1);
        this._mainThreadWorkerClient = new WorkerClient(this, port2, {
            eager: false,
            maxConcurency: this._options.workerConcurency,
        }, 'main');
    }
    /** Will only be true if all work queued and discovered so far has been completed. */
    get isIdle() {
        return this._ownedTasks === 0;
    }
    on(event, listener) {
        this._eventsEmmiter.on(event, listener);
        return this;
    }
    emit(event, ...args) {
        return this._eventsEmmiter.emit(event, ...args);
    }
    /** Add a task to be performed. */
    addTask(arg, opts) {
        const id = (this._nextTaskId++).toString();
        return this._registerTask(id, arg, opts || {});
    }
    _registerTask(id, arg, options) {
        this._ownedTasks += 1;
        if (this._workers.length < this._options.maxWorkers &&
            this._ownedTasks - this._mainThreadWorkerClient.ownedTasks >
                this._workers.length * this._options.taskPerWorker) {
            this._launchWorker();
        }
        const newTask = new TaskImpl(id, options, arg);
        const assignee = this._chooseWorker(newTask);
        if (assignee) {
            assignee._enqueue(newTask);
        }
        else {
            this._freeTasks.push(newTask);
        }
        this.emit('task-added', newTask);
        if (this._idleWorkers.length > 0 && !this._stealing) {
            // We intentionally use the slow-ish setTimeout in order to let backlogs pile up ever so slightly
            this._stealing = setTimeout(() => this._stealWork(), 0);
        }
        return newTask;
    }
    _completed(task, result) {
        this._ownedTasks -= 1;
        this.emit('task-complete', undefined, result, task);
    }
    _failed(task, err) {
        this._ownedTasks -= 1;
        this.emit('task-complete', err, undefined, task);
    }
    dispose() {
        this._workers.forEach((w) => w.dispose());
        this._mainThreadWorkerClient.dispose();
        if (this._stealing) {
            clearTimeout(this._stealing);
        }
    }
    /** Wait until the pool is not performing any work anymore. */
    async whenIdle() {
        return new Promise((resolve) => {
            if (this.isIdle) {
                resolve();
            }
            else {
                this._onNextIdle.push(resolve);
            }
        });
    }
    _notifyIdle(worker) {
        if (worker._options.eager) {
            this._idleWorkers.push(worker);
        }
        if (this.isIdle) {
            this._onNextIdle.forEach((cb) => cb());
            this._onNextIdle = [];
        }
    }
    _launchWorker() {
        const data = {
            entrypointModule: this._entrypointModule,
            entrypointSymbol: this._options.entrypointSymbol,
            workerId: this._workers.length,
        };
        const worker = new worker_threads_1.Worker(worker_location_js_1.default, { workerData: data });
        const client = new WorkerClient(this, worker, { eager: true, maxConcurency: this._options.workerConcurency }, this._workers.length.toString());
        this._workers.push(client);
    }
    _chooseWorker(task) {
        const options = task.options;
        if (options.workerAffinity !== undefined) {
            if (options.workerAffinity === 'main') {
                return this._mainThreadWorkerClient;
            }
            else {
                return this._workers[options.workerAffinity];
            }
        }
        return this._idleWorkers.pop();
    }
    _findTask() {
        return this._freeTasks.pop();
    }
    _stealWork() {
        // I am generally unhappy with this algorithm. especially wrt/ strong affinity.
        // If a worker that had stuff stolen from them gets around to consuming from the free list
        // while the stolen tasks are still there. They should be prioritized.
        this._stealing = undefined;
        // Check to see if the situation hasn't resolved itself.
        if (this._idleWorkers.length === 0)
            return;
        const stolen = [];
        const concurency = this._options.workerConcurency;
        let pressure = this._idleWorkers.length * concurency * 2;
        // Only consider workers that are fully busy.
        const workers = this._workers.filter((w) => w.ownedTasks >= concurency * 2);
        workers.sort((a, b) => b.ownedTasks - a.ownedTasks);
        // First pass: steal light affinity tasks
        const candidateCount = workers.length;
        for (let i = 0; i < candidateCount && pressure > 0; ++i) {
            const w = workers[i];
            const taken = w._queues[AFFINITY_LIGHT];
            w._queues[AFFINITY_LIGHT] = [];
            w.ownedTasks -= taken.length;
            pressure -= taken.length;
            stolen.push(...taken);
        }
        // second pass: steal strong affinity tasks
        for (let i = 0; i < candidateCount && pressure > 0; ++i) {
            const w = workers[i];
            const taken = w._queues[AFFINITY_STRONG];
            w._queues[AFFINITY_STRONG] = [];
            w.ownedTasks -= taken.length;
            pressure -= taken.length;
            stolen.push(...taken);
        }
        this._freeTasks.push(...stolen);
        this._flushIdlers();
    }
    _flushIdlers() {
        const idlers = this._idleWorkers;
        this._idleWorkers = [];
        for (const i of idlers) {
            i._flush();
        }
    }
}
class TaskImpl {
    constructor(id, options, arg) {
        // TODO: This interaction with Promise<U> is janky as all heck.
        // There's got to be a better way.
        let tmpResolve;
        let tmpReject;
        this._prom = new Promise((resolve, reject) => {
            tmpResolve = resolve;
            tmpReject = reject;
        });
        this.id = id;
        this.options = options;
        this.arg = arg;
        this.doresolve = tmpResolve;
        this.doreject = tmpReject;
    }
    then(onfulfilled, onrejected) {
        return this._prom.then(onfulfilled, onrejected);
    }
}
exports.WorkerPool = WorkerPoolImpl;
//# sourceMappingURL=index.js.map