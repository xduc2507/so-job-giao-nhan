// Kiểm tra cú pháp JS nội tuyến trong so-job.html (node --check không đọc được file .html)
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { inlineScripts } from "./app-source.mjs";

test("so-job.html có mã <script> nội tuyến", () => {
  assert.ok(inlineScripts().length > 0);
});

inlineScripts().forEach((code, i) => {
  test(`<script> #${i + 1} trong so-job.html đúng cú pháp`, () => {
    assert.doesNotThrow(() => new vm.Script(code, { filename: `so-job.html#script${i + 1}` }));
  });
});
