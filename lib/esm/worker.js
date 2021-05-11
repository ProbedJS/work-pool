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
const isPromise = (v) => {
    return (typeof v === 'object' &&
        v !== null &&
        v.then !== undefined);
};
/**
 * This class is handles both the main thread as well
 * as the worker thread.
 */
export class TaskWorker {
    constructor(config, port) {
        this._nextTaskId = 0;
        this._id = config.workerId;
        import(config.entrypointModule).then((entry) => {
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
if (!isMainThread) {
    new TaskWorker(workerData, parentPort);
}
//# sourceMappingURL=worker.js.map