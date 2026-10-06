import { decodeText, type Evidence, type Item } from "./model";
self.onmessage = (
  event: MessageEvent<{ files: Evidence[]; query: string }>,
) => {
  const results: Item[] = [];
  const { files, query } = event.data;
  if (!query) {
    self.postMessage(results);
    return;
  }
  const needle = new TextEncoder().encode(query);
  for (const file of files) {
    let offset = 0;
    while (results.length < 500) {
      const found = file.bytes.indexOf(needle[0], offset);
      if (found < 0) break;
      if (needle.every((b, i) => file.bytes[found + i] === b)) {
        results.push({
          id: `${file.id}:search:${found}`,
          name: decodeText(
            file.bytes.subarray(
              Math.max(0, found - 25),
              found + needle.length + 60,
            ),
          ).replace(/\s/g, " "),
          kind: "search result",
          detail: file.name,
          location: {
            fileId: file.id,
            start: found,
            end: found + needle.length,
          },
        });
        offset = found + needle.length;
      } else offset = found + 1;
    }
    if (results.length >= 500) break;
  }
  self.postMessage(results);
};
