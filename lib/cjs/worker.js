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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskWorker = void 0;
const worker_threads_1 = require("worker_threads");
const isPromise = (v) => {
    return (typeof v === 'object' &&
        v !== null &&
        v.then !== undefined);
};
/**
 * This class is handles both the main thread as well
 * as the worker thread.
 */
class TaskWorker {
    constructor(config, port) {
        this._nextTaskId = 0;
        this._id = config.workerId;
        Promise.resolve().then(() => __importStar(require(config.entrypointModule))).then((entry) => {
            this._impl = entry[config.entrypointSymbol];
            this._port.postMessage({ type: 'ready' });
        });
        this._port = port;
        port.on('message', this._recv.bind(this));
    }
    addTask(arg, opts) {
        const options = {
            workerAffinity: this._id !== 'main' ? this._id : undefined,
            affinityStrength: 0,
            ...opts,
        };
        const msg = {
            type: 'task-discovered',
            id: `${this._id}_${this._nextTaskId}`,
            arg,
            options,
        };
        this._nextTaskId += 1;
        this._port.postMessage(msg);
    }
    _postResult(id, options, result) {
        const msg = {
            type: 'task-complete',
            id,
            options,
            result,
        };
        this._port.postMessage(msg);
    }
    _postFailure(id, options, error) {
        const msg = {
            type: 'task-failed',
            id,
            options,
            error,
        };
        this._port.postMessage(msg);
    }
    _recv(msg) {
        switch (msg.type) {
            case 'exit':
                this._port.close();
                break;
            case 'add-task':
                this._receiveTask(msg);
                break;
            default:
                break;
        }
    }
    _receiveTask(msg) {
        const { arg, options, id } = msg;
        try {
            const rawResult = this._impl(arg, this);
            if (isPromise(rawResult)) {
                rawResult
                    .then((result) => {
                    this._postResult(id, options, result);
                })
                    .catch((error) => {
                    this._postFailure(id, options, error);
                });
            }
            else {
                this._postResult(id, options, rawResult);
            }
        }
        catch (error) {
            this._postFailure(id, options, error);
        }
    }
}
exports.TaskWorker = TaskWorker;
if (!worker_threads_1.isMainThread) {
    new TaskWorker(worker_threads_1.workerData, worker_threads_1.parentPort);
}
//# sourceMappingURL=worker.js.map