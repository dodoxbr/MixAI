import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Principal } from "../server/auth.js";
import { ReferenceError } from "../reference/schema.js";
import type { AutoConfigAdvisoryPort } from "./suggestion-source.js";
import type { AutoConfigService } from "./service.js";
/** Authentication is delegated to the central ingress policy; no second credentials or PIN. */
export async function autoConfigRoutes(
  app: FastifyInstance,
  opts: {
    service: AutoConfigService;
    advisor?: AutoConfigAdvisoryPort;
    origin?: string;
    principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
    active(p: Principal): boolean;
  },
) {
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook("onRequest", async (req, reply) => {
    const p = opts.principal(req, reply);
    if (!p) return reply;
    if (p.role !== "operator")
      return reply.code(403).send({ code: "FORBIDDEN" });
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      req.headers.origin !== (opts.origin ?? `http://${req.headers.host}`)
    )
      return reply.code(403).send({ code: "FORBIDDEN" });
    actors.set(req, p);
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("cache-control", "no-store");
    const p = actors.get(req);
    if (p && !opts.active(p)) {
      reply.code(401);
      return JSON.stringify({ code: "UNAUTHORIZED" });
    }
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    const code = error instanceof ReferenceError ? error.code : "INVALID";
    const status =
      code === "UNAUTHORIZED"
        ? 401
        : code === "FORBIDDEN"
          ? 403
          : code === "NOT_FOUND"
            ? 404
            : code === "STORE_UNAVAILABLE" || code === "DEPENDENCY_UNAVAILABLE"
              ? 503
              : code === "INVALID"
                ? 400
                : 409;
    reply.code(status).send({ code });
  });
  if (opts.advisor) app.post("/api/autoconfig/suggestions", { bodyLimit: 4096 }, req => opts.advisor!.suggest(actors.get(req)!, req.body));
  app.get("/api/autoconfig", (req) => opts.service.list(actors.get(req)!));
  app.get<{ Params: { id: string } }>("/api/autoconfig/:id", (req) =>
    opts.service.detail(actors.get(req)!, req.params.id),
  );
  app.post("/api/autoconfig", { bodyLimit: 16384 }, (req) =>
    opts.service.create(actors.get(req)!, req.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/autoconfig/:id/actions",
    { bodyLimit: 16384 },
    (req) => opts.service.action(actors.get(req)!, req.params.id, req.body),
  );
}
