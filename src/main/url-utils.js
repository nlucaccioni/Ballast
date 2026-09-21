function rootDomain(hostname) {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

// Hostnames that look like a third-party identity provider (accounts.
// google.com, login.microsoftonline.com, ...) even on a root domain
// completely unrelated to the app itself — covers federated/SSO sign-in.
const AUTH_SUBDOMAIN_PATTERN = /^(accounts|login|signin|auth|sso|id)\./i;

// Company-specific SSO tenants (yourcompany.okta.com, yourcompany.
// onelogin.com, a custom Auth0/PingIdentity/Azure AD domain, ...) give no
// hostname hint at all — the "auth" part of the name is on a subdomain
// AUTH_SUBDOMAIN_PATTERN doesn't own. OAuth2/OIDC and SAML requests are
// standardized protocols, though, so the URL *shape* (an /authorize or
// /oauth2/... path, or client_id/response_type/SAMLRequest query params)
// is a reliable tell regardless of which vendor's domain is behind it.
function looksLikeAuthFlow(parsedUrl) {
  if (AUTH_SUBDOMAIN_PATTERN.test(parsedUrl.hostname)) return true;
  if (/\/(oauth2?|saml2?|sso|authorize)(\/|$)/i.test(parsedUrl.pathname)) return true;
  const params = parsedUrl.searchParams;
  if (params.has('client_id') || params.has('response_type') || params.has('SAMLRequest')) return true;
  return false;
}

module.exports = { rootDomain, AUTH_SUBDOMAIN_PATTERN, looksLikeAuthFlow };
