/* What conda-forge's Scotch for Windows, a static library built with
   Microsoft's compiler, expects of Microsoft's runtime and MinGW-w64 lacks.
   scripts/build-solver.py links the two into a MinGW scotch.dll for PaStiX.

   - Buffer-overrun checks (/GS): the cookie, its check and the exception
     handler of the functions that use it. The check accepts any value, as
     MinGW code itself does not use the scheme.
   - fprintf, fscanf, sprintf, sscanf and vfprintf, which the UCRT's
     headers define inline over its __stdio_common_* functions, so its
     library does not export them; MSVC's objects call them by name, and
     __local_stdio_printf_options, which those inlines read.
   - __isa_available, the processor level MSVC's runtime records; zero
     means the baseline, which Scotch's code reads only to pick its own
     memory routines. (__chkstk, the stack probe, is MinGW's ___chkstk_ms,
     given that name at link time.)

   Licensed like CalculiX: GNU General Public License, version 2 or later. */

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

typedef struct _iobuf FILE;

int __isa_available = 0;

static unsigned long long printf_options;
unsigned long long *__local_stdio_printf_options(void) {
  return &printf_options;
}

uintptr_t __security_cookie = 0x2B992DDFA232ULL;

void __security_check_cookie(uintptr_t cookie) { (void)cookie; }

/* EXCEPTION_DISPOSITION: ExceptionContinueSearch. */
int __GSHandlerCheck(void *record, void *frame, void *context,
                     void *dispatcher) {
  (void)record; (void)frame; (void)context; (void)dispatcher;
  return 1;
}

__declspec(dllimport) int __stdio_common_vfprintf(unsigned long long options,
                                                  FILE *stream,
                                                  const char *format,
                                                  void *locale, va_list args);
__declspec(dllimport) int __stdio_common_vfscanf(unsigned long long options,
                                                 FILE *stream,
                                                 const char *format,
                                                 void *locale, va_list args);
__declspec(dllimport) int __stdio_common_vsscanf(unsigned long long options,
                                                 const char *buffer,
                                                 size_t count,
                                                 const char *format,
                                                 void *locale, va_list args);
__declspec(dllimport) int __stdio_common_vsprintf(unsigned long long options,
                                                  char *buffer, size_t count,
                                                  const char *format,
                                                  void *locale, va_list args);

int vfprintf(FILE *stream, const char *format, va_list args) {
  return __stdio_common_vfprintf(0, stream, format, NULL, args);
}

int fprintf(FILE *stream, const char *format, ...) {
  va_list args;
  int n;
  va_start(args, format);
  n = __stdio_common_vfprintf(0, stream, format, NULL, args);
  va_end(args);
  return n;
}

int fscanf(FILE *stream, const char *format, ...) {
  va_list args;
  int n;
  va_start(args, format);
  n = __stdio_common_vfscanf(0, stream, format, NULL, args);
  va_end(args);
  return n;
}

int sprintf(char *buffer, const char *format, ...) {
  va_list args;
  int n;
  va_start(args, format);
  n = __stdio_common_vsprintf(0, buffer, (size_t)-1, format, NULL, args);
  va_end(args);
  return n;
}

int sscanf(const char *buffer, const char *format, ...) {
  va_list args;
  int n;
  va_start(args, format);
  n = __stdio_common_vsscanf(0, buffer, (size_t)-1, format, NULL, args);
  va_end(args);
  return n;
}
