import {
  buildLoginRedirect,
  getDefaultProtectedPath,
  isAuthenticatedCookieHeader,
  isProtectedPath,
  normalizeAppPath,
  shouldUseAppBase
} from './lib/auth.js';

export default async function middleware(request) {
  const { pathname, search } = new URL(request.url);
  const normalizedPath = normalizeAppPath(pathname);
  const authenticated = await isAuthenticatedCookieHeader(request.headers.get('cookie') || '');

  if (normalizedPath === '/password') {
    if (authenticated) {
      const destination = new URL(getDefaultProtectedPath(shouldUseAppBase(pathname)), request.url);
      return Response.redirect(destination, 302);
    }

    return;
  }

  if (isProtectedPath(pathname) && !authenticated) {
    const destination = new URL(buildLoginRedirect(pathname, search), request.url);
    return Response.redirect(destination, 302);
  }

  return;
}

export const config = {
  matcher: [
    '/emr/kid',
    '/emr/kid/:path*',
    '/((?!_next/|favicon.ico|icons/|assets/|public/|.*\\.(?:css|js|png|jpg|jpeg|gif|svg|webp|ico|json|webmanifest|txt|xml|pdf|map)$).*)'
  ]
};
