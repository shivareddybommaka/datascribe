/** Sign-in entry points: app chrome, not CMS content, so editors can't remove them. */
export const LOGIN_LINKS = [
  { label: 'Client login', href: '/portal/login' },
  { label: 'Staff login', href: '/console/login' },
] as const;
