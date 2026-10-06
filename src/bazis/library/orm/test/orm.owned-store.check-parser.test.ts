import { expect, test } from "bun:test";
import { parseRenderedCheck } from "../Schema/CheckExpression";

const compare = (right: string | boolean | number | null) => ({ kind: "compare" as const, left: "flag", op: "=" as const, right });

test("CHECK parser recognizes bare boolean operands before identifier sentinels", () => {
  for (const [source, value] of [["TRUE", true], ["true", true], ["TrUe", true], ["FALSE", false], ["false", false], ["FaLsE", false]] as const) {
    expect(parseRenderedCheck(`flag = ${source}`)).toEqual(compare(value));
  }
  expect(parseRenderedCheck('flag = "TRUE"')).toEqual(compare("\0TRUE"));
  expect(parseRenderedCheck('flag = "FALSE"')).toEqual(compare("\0FALSE"));
  expect(parseRenderedCheck("flag = ordinary_identifier")).toEqual(compare("\0ordinary_identifier"));
  expect(parseRenderedCheck("flag = -17")).toEqual(compare(-17));
  expect(parseRenderedCheck("flag = 'TRUE'")).toEqual(compare("TRUE"));
  expect(parseRenderedCheck("flag = NULL")).toEqual(compare("\0NULL"));
  expect(parseRenderedCheck("flag IS NULL")).toEqual({ kind: "null", left: "flag", not: false });
  expect(parseRenderedCheck("flag IS NOT NULL")).toEqual({ kind: "null", left: "flag", not: true });
  expect(parseRenderedCheck("flag = 1.5")).toBeUndefined();
});
