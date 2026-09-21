function rootDomain(hostname) {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

module.exports = { rootDomain };
