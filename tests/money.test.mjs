// Kiểm thử phần tính tiền của báo giá / debit: đọc số, cộng theo loại tiền, VAT, tổng VND / USD
import { test } from "node:test";
import assert from "node:assert/strict";
import { pick } from "./app-source.mjs";

const { num, fmt, totals, quoteSums, debitFromQuote } = pick("num", "fmt", "totals", "quoteSums", "debitFromQuote");
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
// vm trả về đối tượng của context khác, nên so sánh qua JSON
const plain = (v) => JSON.parse(JSON.stringify(v));

test("num đọc số kiểu Việt Nam và bỏ ký tự lạ", () => {
  assert.equal(num(1500), 1500);
  assert.equal(num("1.500"), 1500); // dấu chấm phân cách hàng nghìn
  assert.equal(num("1.234.567"), 1234567);
  assert.equal(num("2.000.000 đ"), 2000000);
  assert.equal(num("1,500,000"), 1500000);
  assert.equal(num("1.5"), 1.5); // một dấu chấm, không đủ 3 số sau: số lẻ
  assert.equal(num("-2"), -2);
  for (const v of ["", "abc", null, undefined, Infinity, NaN]) assert.equal(num(v), 0);
});

test("fmt: VND không có số lẻ, USD tối đa 2 số lẻ", () => {
  assert.equal(fmt(1234567, "VND"), "1.234.567");
  assert.equal(fmt(1234567.6, "VND"), "1.234.568");
  assert.equal(fmt(1234.5, "USD"), "1.234,5");
  assert.equal(fmt(0.125, "USD"), "0,13");
  assert.equal(fmt("x", "VND"), "0");
});

test("totals cộng qty × đơn giá theo từng loại tiền, mặc định VND", () => {
  const j = { quote: [
    { qty: 2, price: "1.500.000" },
    { qty: 1, price: 350000, currency: "VND" },
    { qty: 3, price: 45.5, currency: "USD" },
  ] };
  assert.deepEqual(plain(totals(j)), { VND: 3350000, USD: 136.5 });
  assert.deepEqual(plain(totals({})), {});
  assert.deepEqual(plain(totals({ quote: [] })), {});
});

test("quoteSums tính VAT riêng cho VND và USD", () => {
  const s = quoteSums({ vat: 8, quote: [
    { qty: 3, price: "1.500.000" },
    { qty: 2, price: 45.5, currency: "USD" },
  ] });
  assert.equal(s.length, 2);
  const [vnd, usd] = s;
  assert.equal(vnd.cur, "VND");
  assert.equal(vnd.sub, 4500000);
  assert.equal(vnd.vat, 360000);
  assert.equal(vnd.total, 4860000);
  assert.equal(usd.cur, "USD");
  assert.equal(usd.sub, 91);
  close(usd.vat, 7.28);
  close(usd.total, 98.28);
});

test("quoteSums: VAT 0 hoặc để trống thì Tổng = Cộng", () => {
  for (const vat of [0, "", undefined, "abc"]) {
    const [r] = quoteSums({ vat, quote: [{ qty: 1, price: 1000000 }] });
    assert.equal(r.vat, 0);
    assert.equal(r.total, 1000000);
  }
  assert.equal(quoteSums({ vat: 10, quote: [] }).length, 0);
});

test("quoteSums đọc VAT dạng chuỗi", () => {
  const [r] = quoteSums({ vat: "10", quote: [{ qty: "2", price: "500.000" }] });
  assert.equal(r.total, 1100000);
});

test("debitFromQuote lấy tổng sau VAT, ưu tiên VND", () => {
  const d = debitFromQuote({ vat: 10, quote: [
    { qty: 1, price: 25, currency: "USD" },
    { qty: 2, price: "1.000.000" },
  ] });
  assert.deepEqual(plain(d), { amount: 2200000, currency: "VND", multi: true });
});

test("debitFromQuote chỉ có USD thì lấy USD, làm tròn 2 số lẻ", () => {
  const d = debitFromQuote({ vat: 8, quote: [{ qty: 3, price: 33.333, currency: "USD" }] });
  assert.equal(d.currency, "USD");
  assert.equal(d.multi, false);
  assert.equal(d.amount, 108); // 99,999 × 1,08 = 107,99892 → 108
});

test("debitFromQuote trả null khi báo giá trống", () => {
  assert.equal(debitFromQuote({ vat: 10, quote: [] }), null);
  assert.equal(debitFromQuote({}), null);
});
