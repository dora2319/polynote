"use strict";

import {VegaInterpreter} from "./vega_interpreter";
import {ClientResult, ExecutionInfo, ResultValue, RuntimeError} from "../data/result";
import {append, setValue} from "../state";
import {NotebookMessageDispatcher} from "../messaging/dispatcher";
import {NotebookMessageReceiver} from "../messaging/receiver";
import {CellResult, CellStatusUpdate, KernelStatus, TaskInfo, TaskStatus, UpdatedTasks} from "../data/messages";
import {DataRepr, StreamingDataRepr} from "../data/value_repr";
import {DataStream} from "../messaging/datastream";
import {NotebookStateHandler} from "../state/notebook_state";
import {ServerStateHandler} from "../state/server_state";

export interface CellContext {
    id: number,
    availableValues: Record<string, any>
}

export interface IClientInterpreter {
    languageTitle: string;
    highlightLanguage: string;
    interpret(code: string, cellContext: CellContext): (ClientResult | RuntimeError)[]
}

export const ClientInterpreters: Record<string, IClientInterpreter> = {
    "vega": VegaInterpreter
};

/**
 *  The ClientInterpreter interprets client-side cells (currently, Vega cells). It acts like the backend, receiving
 *  messages from the dispatcher and sending messages to the receiver.
 *
 *  This will hopefully make it easier to fold vega / js interpretation into the server if we decide to do that.
 *
 */
export class ClientInterpreter {

    private static instances: Record<string, ClientInterpreter> = {};
    private constructor(private notebookState: NotebookStateHandler, private receiver: NotebookMessageReceiver) {}

    static forPath(path: string): ClientInterpreter | undefined {
        let inst = ClientInterpreter.instances[path];
        if (inst === undefined) {
            const nbInfo = ServerStateHandler.getNotebook(path);
            if (nbInfo && nbInfo.info) {
                inst = new ClientInterpreter(nbInfo.handler, nbInfo.info.receiver);
                ClientInterpreter.instances[path] = inst;
            }
        }
        return inst
    }

    runCell(id: number, dispatcher: NotebookMessageDispatcher, queueAfter?: number) {
        // we want to run the cell in order, so we need to find any cells above this one that are currently running/queued
        // and wait for them to complete
        const nbState = this.notebookState.state
        const cellIdx = this.notebookState.getCellIndex(id)!
        const cell = nbState.cells[cellIdx]!;

        // first, queue up the cell, waiting for another cell to queue if necessary
        Promise.resolve().then(() => {
            if (queueAfter !== undefined) {
                return this.notebookState.waitForCellChange(queueAfter, "queued")
            } else return Promise.resolve()
        }).then(() => {
            const promise = this.notebookState.waitForCellChange(cellIdx, "queued");
            this.receiver.inject(new KernelStatus(new CellStatusUpdate(id, TaskStatus.Queued)))
            return promise
        }).then(() => { // next, wait for any cells queued up earlier.
            let waitIdx = cellIdx;
            let waitCellId: number | undefined = undefined;
            while (waitIdx >= 0 && waitCellId === undefined) {
                waitIdx -= 1;
                const maybeWaitCell = this.notebookState.state.cells[waitIdx]
                if (maybeWaitCell && (maybeWaitCell.queued || maybeWaitCell.running)) {
                    waitCellId = maybeWaitCell.id;
                }
            }

            if (waitCellId) {
                return new Promise(resolve => {
                    const disposable = this.notebookState.addObserver(state => {
                        const maybeCellReady = state.cells[waitCellId!];
                        if (maybeCellReady && !maybeCellReady.running && !maybeCellReady.queued) {
                            disposable.dispose();
                            resolve();
                        }
                    })
                })
            } else return Promise.resolve()
        }).then(() => { // finally, interpret the cell
            const taskId = `Cell ${id}`
            const start = Date.now()
            const updateStatus = (progress: number) => {
                if (progress < 256) {
                    this.receiver.inject(new KernelStatus(new CellStatusUpdate(id, TaskStatus.Running)))
                    this.receiver.inject(new KernelStatus(new UpdatedTasks([new TaskInfo(taskId, taskId, '', TaskStatus.Running, progress)])))
                    this.receiver.inject(new CellResult(id, new ExecutionInfo(start)))
                } else {
                    this.receiver.inject(new KernelStatus(new CellStatusUpdate(id, TaskStatus.Complete)))
                    this.receiver.inject(new KernelStatus(new UpdatedTasks([new TaskInfo(taskId, taskId, '', TaskStatus.Complete, progress)])))
                    this.receiver.inject(new CellResult(id, new ExecutionInfo(start, Date.now())))
                }
            }
            updateStatus(1)

            const currentState = this.notebookState.state;
            const availableValues = currentState.cellOrder.slice(0, cellIdx).reduce<Record<string, any>>((acc, next) => {
                currentState.cells[next].results
                    .filter(res => res instanceof ResultValue) // for now, ClientResults can't be used in other cells
                    .forEach((result: ResultValue) => {
                        let bestValue: any = result.valueText;
                        const dataRepr = result.reprs.find(repr => repr instanceof DataRepr);
                        if (dataRepr) {
                            bestValue = (dataRepr as DataRepr).decode();
                        } else {
                            const streamingRepr = result.reprs.find(repr => repr instanceof StreamingDataRepr);
                            if (streamingRepr instanceof StreamingDataRepr) {
                                bestValue = new DataStream(dispatcher, this.notebookState, streamingRepr);
                            }
                        }
                        acc[result.name] = bestValue;
                    })
                return acc
            }, {})
            const results = ClientInterpreters[cell.language].interpret(cell.content, {id, availableValues})
            updateStatus(256)
            results.forEach(res => {
                if (res instanceof RuntimeError) {
                    this.receiver.inject(new CellResult(id, res))
                } else {
                    res.toOutput().then(o => {
                        const results = this.notebookState.cellsHandler.state[id].results;
                        this.notebookState.cellsHandler.updateField(id, { results: append(res), output: setValue([o])})
                    })
                }
            })
        })
    }

}