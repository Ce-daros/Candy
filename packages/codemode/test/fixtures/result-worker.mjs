import { parentPort, workerData } from "node:worker_threads";

parentPort.postMessage(JSON.parse(workerData.code));
