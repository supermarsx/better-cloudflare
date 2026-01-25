import { Router } from "express";
import { ServerAPI } from "../lib/server-api";
import { asyncHandler } from "../lib/async-handler";
import { isAdmin } from "../lib/rbac";

/**
 * Express router wiring the API endpoints used by the client and server.
 * The endpoints are implemented in `ServerAPI` and wrapped in `asyncHandler`
 * to forward errors to the global error middleware.
 */
/**
 * Router containing API endpoints for the express server.
 *
 * Endpoints:
 * - POST /api/verify-token
 * - GET /api/zones
 * - GET /api/zones/:zone/dns_records
 * - POST /api/zones/:zone/dns_records
 * - PUT /api/zones/:zone/dns_records/:id
 * - DELETE /api/zones/:zone/dns_records/:id
 */
export const apiRouter = (Router as any)();

apiRouter.post("/api/verify-token", asyncHandler(ServerAPI.verifyToken()));

apiRouter.get("/api/zones", asyncHandler(ServerAPI.getZones()));

apiRouter.get(
  "/api/zones/:zone/dns_records",
  asyncHandler(ServerAPI.getDNSRecords()),
);

apiRouter.post(
  "/api/zones/:zone/dns_records",
  asyncHandler(ServerAPI.createDNSRecord()),
);

apiRouter.post(
  "/api/zones/:zone/dns_records/bulk",
  asyncHandler(ServerAPI.createBulkDNSRecords()),
);
apiRouter.get(
  "/api/zones/:zone/dns_records/export",
  asyncHandler(ServerAPI.exportDNSRecords()),
);
// Optional OS vault endpoints for storing/retrieving secrets when running a
// local server configured to use OS keychain (via `keytar`). These endpoints
// are intentionally minimal and require the server to be local/trusted.
apiRouter.post("/api/vault/:id", asyncHandler(ServerAPI.storeVaultSecret()));
apiRouter.get("/api/vault/:id", asyncHandler(ServerAPI.getVaultSecret()));
apiRouter.delete(
  "/api/vault/:id",
  isAdmin,
  asyncHandler(ServerAPI.deleteVaultSecret()),
);

apiRouter.get(
  "/api/passkeys/register/options/:id",
  asyncHandler(ServerAPI.createPasskeyRegistrationOptions()),
);
apiRouter.post(
  "/api/passkeys/register/:id",
  asyncHandler(ServerAPI.registerPasskey()),
);
apiRouter.get(
  "/api/passkeys/authenticate/options/:id",
  asyncHandler(ServerAPI.createPasskeyAuthOptions()),
);
apiRouter.post(
  "/api/passkeys/authenticate/:id",
  asyncHandler(ServerAPI.authenticatePasskey()),
);
apiRouter.get("/api/passkeys/:id", asyncHandler(ServerAPI.listPasskeys()));
apiRouter.delete(
  "/api/passkeys/:id/:cid",
  asyncHandler(ServerAPI.deletePasskey()),
);
apiRouter.get("/api/audit", isAdmin, asyncHandler(ServerAPI.getAuditEntries()));

// SPF simulation & graph endpoints
apiRouter.get("/api/spf/simulate", asyncHandler(ServerAPI.simulateSPF()));
apiRouter.get("/api/spf/graph", asyncHandler(ServerAPI.getSPFGraph()));

// Admin endpoints (only when user management is backed by sqlite)
if (ServerAPI.supportsUserManagement()) {
  apiRouter.post("/api/users", isAdmin, asyncHandler(ServerAPI.createUser()));
  apiRouter.get("/api/users/:id", asyncHandler(ServerAPI.getUser()));
  apiRouter.put(
    "/api/users/:id/roles",
    isAdmin,
    asyncHandler(ServerAPI.updateUserRoles()),
  );
}

apiRouter.put(
  "/api/zones/:zone/dns_records/:id",
  asyncHandler(ServerAPI.updateDNSRecord()),
);

apiRouter.delete(
  "/api/zones/:zone/dns_records/:id",
  asyncHandler(ServerAPI.deleteDNSRecord()),
);
