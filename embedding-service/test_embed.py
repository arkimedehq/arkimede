#!/usr/bin/env python3
"""Quick test: call the embedding service and verify the vector dimension."""

import json
import urllib.request

BASE_URL = "http://localhost:8000"
MODEL    = "mixedbread-ai/mxbai-embed-large-v1"

TEST_TEXT = (
    "This is a test document to verify that the embedding service "
    "returns 1024-dimensional vectors."
)


def post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def main():
    # 1. Health check
    with urllib.request.urlopen(f"{BASE_URL}/health") as r:
        health = json.loads(r.read())
    print(f"[health]  {health}")

    # 2. Embed without dimensions (should return the native dim)
    res = post_json(f"{BASE_URL}/v1/embeddings", {"input": TEST_TEXT, "model": MODEL})
    vec = res["data"][0]["embedding"]
    print(f"\n[embed]   testo: {repr(TEST_TEXT[:60])}...")
    print(f"          vettore dim: {len(vec)}")
    print(f"          prime 5 componenti: {[round(x, 6) for x in vec[:5]]}")

    assert len(vec) == 1024, f"ERRORE: atteso 1024, ottenuto {len(vec)}"
    print("\n✓ Dimensione corretta: 1024")

    # 3. Embed with dimensions=512 (Matryoshka truncation)
    res2 = post_json(f"{BASE_URL}/v1/embeddings", {"input": TEST_TEXT, "model": MODEL, "dimensions": 512})
    vec2 = res2["data"][0]["embedding"]
    print(f"\n[embed512] dimensioni con truncation: {len(vec2)}")
    assert len(vec2) == 512, f"ERRORE: atteso 512, ottenuto {len(vec2)}"
    print("✓ Truncation Matryoshka a 512 funziona")

    # 4. Batch of multiple texts
    texts = ["Farmaco A - paracetamolo 500mg", "Farmaco B - ibuprofene 400mg", "Ricetta medica paziente Rossi"]
    res3  = post_json(f"{BASE_URL}/v1/embeddings", {"input": texts, "model": MODEL})
    print(f"\n[batch]   {len(res3['data'])} vettori da {len(texts)} testi")
    for item in res3["data"]:
        print(f"          [{item['index']}] dim={len(item['embedding'])}")
    assert all(len(d["embedding"]) == 1024 for d in res3["data"])
    print("✓ Batch OK")


if __name__ == "__main__":
    main()