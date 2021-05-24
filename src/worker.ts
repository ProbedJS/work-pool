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

import {
  isMainThread,
  MessagePort,
  parentPort,
  workerData,
} from 'worker_threads';

import { EventEmitter } from 'events';

// We are currently only importing types from WorkerPool. Let's keep it this way.
import {
  AddTaskMsg,
  IWorkerClient,
  MsgBase,
  MsgMsg,
  TaskCompletion,
  UserContent,
  WorkerConfig,
  WorkerEntryPoint,
} from './worker-api';

import { performance } from 'perf_hooks';

export const TASK_COMPLETION_TYPE = '__completion';
export const READY_TYPE = '__ready';
export const ADD_TASK_TYPE = '__add';
export const EXIT_TYPE = '__exit';

export class TaskWorker<T, U> implements IWorkerClient<T> {
  _msgEventsEmmiter: EventEmitter = new EventEmitter();
  _port: MessagePort;
  _impl?: WorkerEntryPoint<T, U>;

  constructor(config: WorkerConfig, port: MessagePort) {
    this._port = port;
    port.on('message', this._recv.bind(this));

    import(config.entrypointModule).then(async (entry) => {
      this._impl = entry[config.entrypointSymbol];

      if (this._impl!.onWorkerStart) {
        await this._impl!.onWorkerStart(this);
      }

      this._port.postMessage({ type: READY_TYPE });
    });
  }

  onMessage(
    type: string,
    listener: (contents: UserContent, client: IWorkerClient<T>) => void
  ): void {
    this._msgEventsEmmiter.on(type, listener);
  }

  postMessageToPool(type: string, contents: UserContent): void {
    const msg: MsgMsg = { type, contents };
    this._port.postMessage(msg);
  }

  _recv(msg: MsgBase): void {
    switch (msg.type) {
      case EXIT_TYPE:
        (async () => {
          if (this._impl!.onWorkerExit) {
            await this._impl!.onWorkerExit(this);
          }
          this._port.close();
        })();
        break;
      case ADD_TASK_TYPE:
        this._receiveTask((msg as unknown) as AddTaskMsg<T>);
        break;
      default:
        this._msgEventsEmmiter.emit(msg.type, (msg as MsgMsg).contents, this);
        break;
    }
  }

  async _receiveTask(msg: AddTaskMsg<T>): Promise<void> {
    const { arg, options, id } = msg;
    let taskCost = 0;
    let pretaskCost = 0;

    if (this._impl!.preTask) {
      const startTime = performance.now();
      await this._impl!.preTask(arg, this);
      pretaskCost = performance.now() - startTime;
    }

    const startTime = performance.now();
    const rawResult = this._impl!(arg, this);

    rawResult
      .then((result) => {
        taskCost = performance.now() - startTime;
        const resMsg: TaskCompletion<U> = {
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
        const resMsg: TaskCompletion<U> = {
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
  new TaskWorker(workerData, parentPort!);
}
