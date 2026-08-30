import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { AuthLayout } from '../components/AuthLayout';
import { FormField } from '../components/FormField';
import { useAuth } from '../context/auth-context';
import { toFormErrors } from '../lib/formErrors';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [values, setValues] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({ fieldErrors: {}, formError: null });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrors({ fieldErrors: {}, formError: null });
    setIsSubmitting(true);

    try {
      await register(values);
      navigate('/', { replace: true });
    } catch (error) {
      setErrors(toFormErrors(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start saving links you will actually find again."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent-text underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <FormField
          id="name"
          label="Name"
          type="text"
          autoComplete="name"
          value={values.name}
          onChange={handleChange}
          error={errors.fieldErrors.name}
          required
        />
        <FormField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={handleChange}
          error={errors.fieldErrors.email}
          required
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={handleChange}
          error={errors.fieldErrors.password}
          required
        />

        {errors.formError ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-ink">
            {errors.formError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="lv-button w-full py-2.5"
        >
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
