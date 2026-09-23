describe('test harness', () => {
  it('blocks real network access in unit tests', () => {
    expect(() => fetch('https://example.com')).toThrow(/Network access is disabled/);
  });
});
