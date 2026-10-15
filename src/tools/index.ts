import { accountHolderTools } from "./accountHolder.js";
import { accountTools } from "./accounts.js";
import { cardTools } from "./cards.js";
import { directDebitTools } from "./directDebits.js";
import { feedTools } from "./feed.js";
import { insightTools } from "./insights.js";
import { payeeTools } from "./payees.js";
import { paymentTools } from "./payments.js";
import { spaceTools } from "./spaces.js";
import type { ToolDef } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool shapes
export const ALL_TOOLS: ToolDef<any>[] = [
  ...accountTools,
  ...insightTools,
  ...feedTools,
  ...spaceTools,
  ...cardTools,
  ...directDebitTools,
  ...payeeTools,
  ...paymentTools,
  ...accountHolderTools,
];
