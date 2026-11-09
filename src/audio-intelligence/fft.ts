/** In-place radix-2 FFT. Internal only; public API validates power-of-two lengths. */
export function fft(real: Float64Array, imaginary: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let width = 2; width <= n; width *= 2) {
    const angle = -2 * Math.PI / width, stepR = Math.cos(angle), stepI = Math.sin(angle);
    for (let start = 0; start < n; start += width) {
      let wr = 1, wi = 0;
      for (let j = 0; j < width / 2; j++) {
        const a = start + j, b = a + width / 2;
        const tr = wr * real[b] - wi * imaginary[b], ti = wr * imaginary[b] + wi * real[b];
        real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
        real[a] += tr; imaginary[a] += ti;
        const nextR = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR; wr = nextR;
      }
    }
  }
}
