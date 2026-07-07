import { describe, expect, test } from "bun:test";
import { floatsToBlob, blobToFloats, readEmbeddingVector } from "./embedding-common";

describe("embedding Float32 blob", () => {
  test("round-trips a vector within float32 precision", () => {
    const vec = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.137);
    const blob = floatsToBlob(vec);
    expect(blob.byteLength).toBe(1024 * 4); // 4KB vs ~12.7KB JSON
    const back = blobToFloats(blob);
    expect(back.length).toBe(1024);
    for (let i = 0; i < vec.length; i++) expect(back[i]!).toBeCloseTo(vec[i]!, 5);
  });

  test("readEmbeddingVector prefers blob, falls back to legacy json", () => {
    const vec = [0.1, -0.2, 0.3];
    expect(readEmbeddingVector({ embedding_blob: floatsToBlob(vec) })).toHaveLength(3);
    expect(readEmbeddingVector({ embedding_json: JSON.stringify(vec) })[0]).toBeCloseTo(0.1, 6);
    expect(readEmbeddingVector({ embedding_blob: null, embedding_json: "" })).toEqual([]);
  });
});
