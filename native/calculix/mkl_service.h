/* CalculiX's PARDISO interface sets MKL's thread count; Accelerate
   manages its own threads. */
#define MKL_DOMAIN_BLAS 1
#define MKL_DOMAIN_PARDISO 4
static inline int mkl_domain_set_num_threads(int n, int domain) { (void)n; (void)domain; return 0; }
