import { startAccountMaintenance } from "./server/account/deletion";
import { startCafeMaintenance } from "./server/cafe/customer";
import { startDocumentWorker } from "./server/documents/worker";
import { env } from "./server/env";
import { startLearningScheduler } from "./server/learning/service";

if (env().DOCUMENT_WORKER_ENABLED) startDocumentWorker();
startLearningScheduler();
startCafeMaintenance();
startAccountMaintenance();
