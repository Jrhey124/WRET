import { analyzeFile } from "./analyze";
import type { Evidence, AnalysisOptions } from "./model";
self.onmessage = async (
  event: MessageEvent<{ file: Evidence; options?: AnalysisOptions }>,
) => {
  try {
    const result = await analyzeFile(
      event.data.file,
      (progress) => self.postMessage({ type: "progress", progress }),
      event.data.options,
    );
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({ type: "error", error: String(error) });
  }
};
