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
  parentPort,
  workerData,
  MessagePort,
} from 'worker_threads';

// We are currently only importing types from WorkerPool. Let's keep it this way.
import { ITaskPool, ProcessFunc, TaskOptions } from './index.js';

export interface MsgFromWorker {
  type: 'ready' | 'task-complete' | 'task-failed' | 'task-discovered';
}

export interface TaskCompletion<U> extends MsgFromWorker {
  type: 'task-complete';
  id: string;
  options: TaskOptions;

  result: U;
}

export interface TaskFailure extends MsgFromWorker {
  type: 'task-failed';
  id: string;
  options: TaskOptions;

  error: Error;
}

export interface TaskDiscovery<T> extends MsgFromWorker {
  type: 'task-discovered';

  id: string;
  options: TaskOptions;
  arg: T;
}

export interface MsgToWorker {
  type: 'add-task' | 'exit';
}

export interface AddTaskMsg<T> extends MsgToWorker {
  type: 'add-task';
  id: string;
  options: TaskOptions;

  arg: T;
}

export interface WorkerConfig {
  entrypointModule: string;
  entrypointSymbol: string;
  workerId: 'main' | number;
}

const isPromise = (v: unknown | Promise<unknown>): v is Promise<unknown> => {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Promise<unknown>).then !== undefined
  );
};

/**
 * This class is handles both the main thread as well
 * as the worker thread.
 */
export class TaskWorker<T, U> implements ITaskPool<T> {
  _id: 'main' | number;
  _nextTaskId = 0;
  _port: MessagePort;
  _impl?: ProcessFunc<T, U>;
  constructor(config: WorkerConfig, port: MessagePort) {
    this._id = config.workerId;
    import(config.entrypointModule).then((entry) => {
      this._impl = entry[config.entrypointSymbol];
      this._port.postMessage({ type: 'ready' });
    });
    this._port = port;

    port.on('message', this._recv.bind(this));
  }

  addTask(arg: T, opts?: TaskOptions): void {
    const options: TaskOptions = {
      workerAffinity: this._id !== 'main' ? this._id : undefined,
      affinityStrength: 0,
      ...opts,
    };

    const msg: TaskDiscovery<T> = {
      type: 'task-discovered',
      id: `${this._id}_${this._nextTaskId}`,
      arg,
      options,
    };
    this._nextTaskId += 1;
    this._port.postMessage(msg);
  }

  _postResult(id: string, options: TaskOptions, result: U): void {
    const msg: TaskCompletion<U> = {
      type: 'task-complete',
      id,
      options,
      result,
    };
    this._port.postMessage(msg);
  }

  _postFailure(id: string, options: TaskOptions, error: Error): void {
    const msg: TaskFailure = {
      type: 'task-failed',
      id,
      options,
      error,
    };
    this._port.postMessage(msg);
  }

  _recv(msg: MsgToWorker): void {
    switch (msg.type) {
      case 'exit':
        this._port.close();
        break;
      case 'add-task':
        this._receiveTask(msg as AddTaskMsg<T>);
        break;
      default:
        break;
    }
  }

  _receiveTask(msg: AddTaskMsg<T>): void {
    const { arg, options, id } = msg;

    try {
      const rawResult = this._impl!(arg, this);

      if (isPromise(rawResult)) {
        rawResult
          .then((result) => {
            this._postResult(id, options, result);
          })
          .catch((error) => {
            this._postFailure(id, options, error);
          });
      } else {
        this._postResult(id, options, rawResult);
      }
    } catch (error) {
      this._postFailure(id, options, error);
    }
  }
}

if (!isMainThread) {
  new TaskWorker(workerData, parentPort!);
}
