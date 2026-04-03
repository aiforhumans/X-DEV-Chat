@echo off
setlocal

echo ========================================
echo Running all test suites for cchhat
echo ========================================

echo.
echo [1/3] Unit tests
call npm test
if errorlevel 1 (
  echo.
  echo Unit tests failed.
  exit /b 1
)

echo.
echo [2/3] Coverage tests
call npm run test:coverage
if errorlevel 1 (
  echo.
  echo Coverage tests failed.
  exit /b 1
)

echo.
echo [3/3] Integration tests
call npm run test:integration
if errorlevel 1 (
  echo.
  echo Integration tests failed.
  exit /b 1
)

echo.
echo ========================================
echo All tests completed successfully.
echo ========================================
exit /b 0
