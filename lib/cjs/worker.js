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
exports.TaskWorker = exports.EXIT_TYPE = exports.ADD_TASK_TYPE = exports.READY_TYPE = exports.TASK_COMPLETION_TYPE = void 0;
const worker_threads_1 = require("worker_threads");
const events_1 = require("events");
const perf_hooks_1 = require("perf_hooks");
exports.TASK_COMPLETION_TYPE = '__completion';
exports.READY_TYPE = '__ready';
exports.ADD_TASK_TYPE = '__add';
exports.EXIT_TYPE = '__exit';
class TaskWorker {
    constructor(config, port) {
        this._msgEventsEmmiter = new events_1.EventEmitter();
        this._port = port;
        port.on('message', this._recv.bind(this));
        Promise.resolve().then(() => __importStar(require(config.entrypointModule))).then(async (entry) => {
            this._impl = entry[config.entrypointSymbol];
            if (this._impl.onWorkerStart) {
                await this._impl.onWorkerStart(this);
            }
            this._port.postMessage({ type: exports.READY_TYPE });
        });
    }
    onMessage(type, listener) {
        this._msgEventsEmmiter.on(type, listener);
    }
    postMessageToPool(type, contents) {
        const msg = { type, contents };
        this._port.postMessage(msg);
    }
    _recv(msg) {
        switch (msg.type) {
            case exports.EXIT_TYPE:
                (async () => {
                    if (this._impl.onWorkerExit) {
                        await this._impl.onWorkerExit(this);
                    }
                    this._port.close();
                })();
                break;
            case exports.ADD_TASK_TYPE:
                this._receiveTask(msg);
                break;
            default:
                this._msgEventsEmmiter.emit(msg.type, msg.contents, this);
                break;
        }
    }
    async _receiveTask(msg) {
        const { arg, options, id } = msg;
        let taskCost = 0;
        let pretaskCost = 0;
        if (this._impl.preTask) {
            const startTime = perf_hooks_1.performance.now();
            await this._impl.preTask(arg, this);
            pretaskCost = perf_hooks_1.performance.now() - startTime;
        }
        const startTime = perf_hooks_1.performance.now();
        const rawResult = this._impl(arg, this);
        rawResult
            .then((result) => {
            taskCost = perf_hooks_1.performance.now() - startTime;
            const resMsg = {
                options,
                id,
                result,
                taskCost,
                pretaskCost,
            };
            this._port.postMessage({ type: exports.TASK_COMPLETION_TYPE, ...resMsg });
        })
            .catch((error) => {
            taskCost = perf_hooks_1.performance.now() - startTime;
            const resMsg = {
                options,
                id,
                error,
                taskCost,
                pretaskCost,
            };
            this._port.postMessage({ type: exports.TASK_COMPLETION_TYPE, ...resMsg });
        });
    }
}
exports.TaskWorker = TaskWorker;
if (!worker_threads_1.isMainThread) {
    new TaskWorker(worker_threads_1.workerData, worker_threads_1.parentPort);
}
//# sourceMappingURL=worker.js.map