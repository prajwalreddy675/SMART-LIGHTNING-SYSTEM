/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#2563EB',
          dark: '#1D4ED8',
          light: '#3B82F6',
        },
        secondary: {
          DEFAULT: '#06B6D4',
          dark: '#0891B2',
          light: '#22D3EE',
        },
        accent: {
          DEFAULT: '#8B5CF6',
          dark: '#7C3AED',
          light: '#A78BFA',
        },
        success: {
          DEFAULT: '#10B981',
          dark: '#059669',
          light: '#34D399',
        },
        warning: {
          DEFAULT: '#F59E0B',
          dark: '#D97706',
          light: '#FBBF24',
        },
        danger: {
          DEFAULT: '#EF4444',
          dark: '#DC2626',
          light: '#F87171',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Poppins', 'sans-serif'],
        display: ['Poppins', 'Inter', 'sans-serif'],
      },
      boxShadow: {
        premium: '0 8px 32px 0 rgba(31, 38, 135, 0.07)',
        glass: '0 8px 32px 0 rgba(0, 0, 0, 0.2)',
      },
      backdropBlur: {
        glass: '16px',
      }
    },
  },
  plugins: [],
}
