// REST API reference, served at /docs. Swagger UI is bundled here rather than loaded
// from a CDN, so the page needs no third-party scripts on the same origin as sessions.
import { SwaggerUIBundle } from "swagger-ui-dist";
import "swagger-ui-dist/swagger-ui.css";
import "@fontsource-variable/inter";
import "./docs.css";

SwaggerUIBundle({
  url: "/api/v1/openapi.json",
  dom_id: "#api-reference",
  layout: "BaseLayout",
  deepLinking: true,
  docExpansion: "list",
  defaultModelsExpandDepth: 0,
  persistAuthorization: false,
  tryItOutEnabled: false,
  // Requests run from this origin, so a signed-in browser session also authorizes them.
  withCredentials: true,
});
