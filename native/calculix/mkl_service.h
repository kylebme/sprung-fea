/* CalculiX's PARDISO interface sets MKL's thread count through MKL's
   headers. CalculiX is built without MKL: Accelerate manages its own
   threads (macOS), and sprung-solve (pardiso_client.c) takes the count
   from MKL_NUM_THREADS, which pardiso.c sets before its first call. */
#define MKL_DOMAIN_BLAS 1
#define MKL_DOMAIN_PARDISO 4
static inline int mkl_domain_set_num_threads(int n, int domain) { (void)n; (void)domain; return 0; }
