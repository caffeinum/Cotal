import { createUser } from "@nats-io/nkeys";

/**
 * A locally-generated agent identity (an nkey user keypair).
 *
 * The public key is the **stable id** used identically everywhere — `card.id`, the
 * subject-encoded sender token, the JWT subject, and the DM durable name — so the
 * server's ACLs and the wire layout stay in lockstep. The seed is the private half:
 * it never goes on the wire and (from the provisioning step on) is signed into a
 * creds file the endpoint loads to authenticate as this id.
 */
export interface Identity {
  /** User nkey public key (`U…`). The stable agent id. */
  id: string;
  /** User nkey seed (`SU…`). Private — kept off the wire. */
  seed: string;
}

/** Generate a fresh user nkey identity locally. The seed is derived here and never
 *  leaves the generating process except as a creds file handed to its own agent. */
export function newIdentity(): Identity {
  const kp = createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  return { id: kp.getPublicKey(), seed };
}
