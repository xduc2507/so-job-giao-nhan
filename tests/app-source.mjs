// Đọc mã JS nằm trong <script> của so-job.html và lấy riêng vài hàm thuần để kiểm thử
// (không chạy cả trang, vì trang cần DOM và window.claude).
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
export const html = readFileSync(new URL("so-job.html", root), "utf8");

/** Toàn bộ mã trong các thẻ <script> nội tuyến (không có src) */
export function inlineScripts(src = html) {
  return [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** Lấy dòng khai báo `const name=` hoặc `function name(` (các hàm này viết trên một dòng) */
export function declaration(name, src = inlineScripts().join("\n")) {
  const re = new RegExp(`^(?:const ${name}=|function ${name}\\().*$`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`Không thấy khai báo "${name}" trong so-job.html`);
  return m[0];
}

/** Chạy các khai báo đã chọn trong một vm riêng và trả về các hàm đó */
export function pick(...names) {
  const code = names.map((n) => declaration(n)).join("\n") + `\n({${names.join(",")}})`;
  return vm.runInNewContext(code, {});
}
