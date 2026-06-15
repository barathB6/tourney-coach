'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface Course {
  id: string;
  name: string;
  city: string;
  state: string;
}

export default function TournamentSetupWizard() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    causeName: '',
    eventDate: '',
    courseId: '',
  });

  useEffect(() => {
    fetchCourses();
  }, []);

  const fetchCourses = async () => {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('id, name, city, state')
        .order('name');

      if (error) throw error;
      setCourses(data || []);
    } catch (err) {
      setError('Failed to load courses');
      console.error(err);
    }
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      if (!formData.name) throw new Error('Tournament name is required');
      if (!formData.eventDate) throw new Error('Event date is required');
      if (!formData.courseId) throw new Error('Course selection is required');

      console.log('Submitting:', formData);

          const { data, error: tourneyError } = await supabase
          .from('tournaments')
          .insert({
            name: formData.name,
            cause_story: formData.causeName,
            event_date: formData.eventDate,
            course_id: formData.courseId,
            format: 'scramble',
            max_score_rule: 'par',
            shotgun_type: 'double',
            max_players: 128,
            status: 'draft',
      })
      .select('id')
      .single();

      console.log('Supabase response:', { data, error: tourneyError });

      if (tourneyError) throw tourneyError;

      setSuccess(`✓ Tournament created! ID: ${data.id.slice(0, 8)}...`);

      setTimeout(() => {
        setFormData({
          name: '',
          causeName: '',
          eventDate: '',
          courseId: '',
        });
        setStep(1);
      }, 2000);
    } catch (err) {
      console.log('Full error:', err);
      setError(err instanceof Error ? err.message : 'Something went wrong');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            Tournament Setup
          </h1>
          <p className="text-gray-600">Step {step} of 2</p>
        </div>

        <div className="mb-8 flex gap-2">
          {[1, 2].map((num) => (
            <div
              key={num}
              className={`flex-1 h-2 rounded-full transition-colors ${
                num <= step ? 'bg-green-500' : 'bg-gray-300'
              }`}
            />
          ))}
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg shadow-lg p-8"
        >
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tournament Name *
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleInputChange}
                  placeholder="e.g., Springfield Charity Classic"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Cause Name
                </label>
                <input
                  type="text"
                  name="causeName"
                  value={formData.causeName}
                  onChange={handleInputChange}
                  placeholder="e.g., Local Youth Golf Program"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Event Date *
                </label>
                <input
                  type="date"
                  name="eventDate"
                  value={formData.eventDate}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
                  required
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Golf Course *
                </label>
                <select
                  name="courseId"
                  value={formData.courseId}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
                  required
                >
                  <option value="">-- Select a course --</option>
                  {courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.name} ({course.city}, {course.state})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700">{error}</p>
            </div>
          )}

          {success && (
            <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-green-700">{success}</p>
            </div>
          )}

          <div className="mt-8 flex gap-4">
            {step === 2 && (
              <button
                type="button"
                onClick={() => setStep(1)}
                disabled={loading}
                className="flex-1 px-6 py-3 bg-gray-200 text-gray-800 font-medium rounded-lg hover:bg-gray-300 disabled:opacity-50"
              >
                Back
              </button>
            )}
            {step === 1 && (
              <button
                type="button"
                onClick={() => setStep(2)}
                className="flex-1 px-6 py-3 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700"
              >
                Next
              </button>
            )}
            {step === 2 && (
              <button
                type="submit"
                disabled={loading}
                className="flex-1 px-6 py-3 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create Tournament'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}// v2
