import { assertEquals, assertRejects } from "@std/assert";
import { OutputData, type Proof, type Wallet } from "@cashu/cashu-ts";
import { CashuTreasuryForwarder } from "../../src/payments/treasury.ts";

function preview(melt = false): string {
  const outputs = [{
    blindedMessage: {
      amount: melt ? 0 : 8,
      id: "keyset",
      B_: "original-blinded-point",
    },
    blindingFactor: { __cashuBigInt: "1" },
    secret: { __cashuBytes: "c2VjcmV0" },
  }];
  return JSON.stringify({
    method: "bolt11",
    keysetId: "keyset",
    outputData: outputs,
    payload: {
      quote: "quote",
      outputs: outputs.map((output) => output.blindedMessage),
    },
    quote: melt
      ? { quote: "melt", amount: 7, fee_reserve: 1, unit: "sat" }
      : "quote",
    inputs: [{ amount: 8, secret: "input", C: "point", id: "keyset" }],
  });
}

Deno.test("lost mint response restores original blinded outputs and rejects incomplete restoration", async () => {
  let calls = 0;
  let restoredPoint = "";
  let complete = true;
  const wallet = {
    loadMint: () => Promise.resolve(),
    completeMint: () => {
      calls++;
      return Promise.reject(new Error("response lost"));
    },
    getKeyset: () => ({}),
    mint: {
      restore: (payload: { outputs: { B_: string }[] }) => {
        restoredPoint = payload.outputs[0].B_;
        return Promise.resolve({
          outputs: complete
            ? [{ B_: restoredPoint, amount: 8, id: "keyset" }]
            : [],
          signatures: complete
            ? [{ amount: 8, id: "keyset", C_: "signature" }]
            : [],
        });
      },
    },
  } as unknown as Wallet;
  // Keep this transport-recovery test independent of mint cryptography. The
  // real SDK unblinder is used in production and tested by cashu-ts itself.
  const original = OutputData.prototype.toProof;
  OutputData.prototype.toProof = function (signature): Proof {
    return {
      amount: signature.amount,
      id: signature.id,
      C: "point",
      secret: new TextDecoder().decode(this.secret),
    };
  };
  try {
    const forwarder = new CashuTreasuryForwarder(
      "https://mint.example",
      () => wallet,
    );
    const proofs = JSON.parse(await forwarder.completeClaim(preview()));
    assertEquals(restoredPoint, "original-blinded-point");
    assertEquals(proofs[0].secret, "secret");
    assertEquals(proofs[0].amount, 8);
    complete = false;
    await assertRejects(
      () => forwarder.completeClaim(preview()),
      Error,
      "response lost",
    );
    assertEquals(calls, 2);
  } finally {
    OutputData.prototype.toProof = original;
  }
});

Deno.test("paid melt recovery retains change and never submits another payout; pending remains pending", async () => {
  let state = "PAID";
  let calls = 0;
  const wallet = {
    loadMint: () => Promise.resolve(),
    getKeyset: () => ({}),
    completeMelt: () => {
      calls++;
      return Promise.reject(new Error("must not submit"));
    },
    checkMeltQuoteBolt11: () =>
      Promise.resolve({
        quote: "melt",
        amount: 7,
        unit: "sat",
        state,
        payment_preimage: "preimage",
        change: [{ amount: 1, id: "keyset", C_: "signature" }],
      }),
  } as unknown as Wallet;
  const original = OutputData.prototype.toProof;
  OutputData.prototype.toProof = function (signature): Proof {
    return {
      amount: signature.amount,
      id: signature.id,
      C: "point",
      secret: new TextDecoder().decode(this.secret),
    };
  };
  try {
    const forwarder = new CashuTreasuryForwarder(
      "https://mint.example",
      () => wallet,
    );
    const recovered = await forwarder.completePayout(preview(true));
    assertEquals(recovered.paid, true);
    assertEquals(JSON.parse(recovered.changeProofsJson)[0].amount, 1);
    assertEquals(recovered.paymentPreimage, "preimage");
    state = "PENDING";
    assertEquals((await forwarder.completePayout(preview(true))).paid, false);
    assertEquals(calls, 0);
  } finally {
    OutputData.prototype.toProof = original;
  }
});
