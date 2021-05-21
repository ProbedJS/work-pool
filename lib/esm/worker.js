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
import { isMainThread, parentPort, workerData, } from 'worker_threads';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
export const TASK_COMPLETION_TYPE = '__completion';
export const READY_TYPE = '__ready';
export const ADD_TASK_TYPE = '__add';
export const EXIT_TYPE = '__exit';
export class TaskWorker {
    constructor(config, port) {
        this._msgEventsEmmiter = new EventEmitter();
        this._port = port;
        port.on('message', this._recv.bind(this));
        import(config.entrypointModule).then(async (entry) => {
            this._impl = entry[config.entrypointSymbol];
            if (this._impl.onWorkerStart) {
                await this._impl.onWorkerStart(this);
            }
            this._port.postMessage({ type: READY_TYPE });
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
            case EXIT_TYPE:
                (async () => {
                    if (this._impl.onWorkerExit) {
                        await this._impl.onWorkerExit(this);
                    }
                    this._port.close();
                })();
                break;
            case ADD_TASK_TYPE:
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
            const startTime = performance.now();
            await this._impl.preTask(arg, this);
            pretaskCost = performance.now() - startTime;
        }
        const startTime = performance.now();
        const rawResult = this._impl(arg, this);
        rawResult
            .then((result) => {
            taskCost = performance.now() - startTime;
            const resMsg = {
                options,
                id,
                result,
                taskCost,
                pretaskCost,
            };
            this._port.postMessage({ type: TASK_COMPLETION_TYPE, ...resMsg });
        })
            .catch((error) => {
            taskCost = performance.now() - startTime;
            const resMsg = {
                options,
                id,
                error,
                taskCost,
                pretaskCost,
            };
            this._port.postMessage({ type: TASK_COMPLETION_TYPE, ...resMsg });
        });
    }
}
if (!isMainThread) {
    new TaskWorker(workerData, parentPort);
}
//# sourceMappingURL=worker.js.map