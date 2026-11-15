import assert from "node:assert/strict";
import test from "node:test";
import { ingestMemory } from "./ingest.js";
import type { MemoryStore } from "./store.js";

function setup() {
  const records: any[] = [], entities: any[] = [], facts: any[] = [], events: any[] = [];
  const store = {
    addRecord: async (value: any) => { const item = { ...value, id: records.length + 1 }; records.push(item); return item; },
    addEntity: async (value: any) => { const item = { ...value, id: entities.length + 1 }; entities.push(item); return item; },
    addFact: async (value: any) => { const item = { ...value, id: facts.length + 1 }; facts.push(item); return item; },
  } as unknown as MemoryStore;
  return { store, records, entities, facts, events, trace: (event: any) => events.push(event) };
}
const record = { source: "test", type: "message", content: "Mira met her friend Jules at the harbor. Jules plans to move to Kyoto." };
const extraction = { entities: [
  { key: "m", type: "person", name: "Mira", aliases: [], status: "confirmed" },
  { key: "j", type: "person", name: "Jules", aliases: [], status: "confirmed" },
], facts: [{ description: "Jules plans to move to Kyoto.", entityKeys: ["j"], validFrom: null, validTo: null, status: "pending", confidence: 0.9 }] };

test("records source, validates model output, links facts and logs the full extraction", async () => {
  const db = setup();
  const result = await ingestMemory(db.store, record, async (input) => { assert.equal(input.record.content, record.content); return JSON.stringify(extraction); }, db.trace);
  assert.equal(result.record.id, 1);
  assert.deepEqual(db.facts[0].entityIds, [2]);
  assert.equal(db.facts[0].recordId, 1);
  assert.equal(db.entities[1].status, "unresolved");
  assert.equal(db.events.find((event) => event.event === "extraction_response").raw, JSON.stringify(extraction));
});

test("invalid model references cannot write entities or facts", async () => {
  const db = setup();
  const bad = { ...extraction, facts: [{ ...extraction.facts[0], entityKeys: ["missing"] }] };
  await assert.rejects(ingestMemory(db.store, record, async () => JSON.stringify(bad), db.trace));
  assert.equal(db.records.length, 1);
  assert.equal(db.entities.length, 0);
  assert.equal(db.facts.length, 0);
  assert.equal(db.events.at(-1).event, "ingest_error");
});
