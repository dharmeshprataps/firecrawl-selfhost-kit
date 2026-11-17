import { TransportableError } from "./error";
import { serializeTransportableError, deserializeTransportableError } from "./error-serde";
import { generateLocalInference, LocalInferenceError, LocalInferenceErrorCode, LOCAL_INFERENCE_ENDPOINT, LOCAL_INFERENCE_MODEL } from "./local-inference";

const base = { baseURL: LOCAL_INFERENCE_ENDPOINT, modelName: LOCAL_INFERENCE_MODEL, markdown: "Value 42.", schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } };
async function expectTransportedFailure(operation: Promise<unknown>, code: LocalInferenceErrorCode) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  // Workers serialize only TransportableError instances; plain Error would lose its code.
  expect(caught).toBeInstanceOf(LocalInferenceError);
  expect(caught).toBeInstanceOf(TransportableError);
  const original = caught as TransportableError;
  const restored = deserializeTransportableError(serializeTransportableError(original));
  expect(restored).toBeInstanceOf(TransportableError);
  expect(restored).toMatchObject({ code, message: original.message, stack: original.stack });
}

describe("Local inference worker error transport", () => {
  it.each(["LOCAL_INFERENCE_UNAVAILABLE", "LOCAL_EXTRACTION_GROUNDING_FAILED"] as const)("round-trips %s without losing messages containing queue delimiters", code => {
    const error = new LocalInferenceError("Failure | retains details", { cause: { reason: "local only" } }, code);
    const restored = deserializeTransportableError(serializeTransportableError(error));
    expect(restored).toBeInstanceOf(TransportableError);
    expect(restored).toMatchObject({ code, message: "Failure | retains details", stack: error.stack, cause: { reason: "local only" } });
  });
  it("preserves an actual local provider outage through serialization without retry or fallback", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expectTransportedFailure(generateLocalInference({ ...base, fetchImpl }), "LOCAL_INFERENCE_UNAVAILABLE");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("preserves a deterministic grounding failure before any model call", async () => {
    const fetchImpl = vi.fn();
    const schema = { type: "object", properties: { latestSales: { type: "number" } }, required: ["latestSales"] };
    await expectTransportedFailure(generateLocalInference({ ...base, schema, prompt: "Extract latest two quarters sales", fetchImpl }), "LOCAL_EXTRACTION_GROUNDING_FAILED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("preserves the grounding failure from a schema-valid but unsupported model number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: '{"value":99999}' }, done: true, done_reason: "stop" })));
    await expectTransportedFailure(generateLocalInference({ ...base, fetchImpl }), "LOCAL_EXTRACTION_GROUNDING_FAILED");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
