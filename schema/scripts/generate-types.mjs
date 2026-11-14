import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "../events.schema.json");
const outPath = path.resolve(__dirname, "../src/types.ts");

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

const ts = await compile(schema, "BLISEventStreamRecordV1", {
  bannerComment:
    "/* eslint-disable */\n/**\n * AUTO-GENERATED from schema/events.schema.json. Do not edit by hand.\n */",
  additionalProperties: false,
  strictIndexSignatures: true
});

const extras = `
export type SimEvent = Exclude<BLISEventStreamRecordV1, HeaderRecord>;
export type SimEventType = SimEvent["type"];

export interface UnknownEvent {
  seq: number;
  t_us: number;
  type: string;
  [key: string]: unknown;
}
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, ts + extras, "utf-8");
console.log("Generated", outPath);
