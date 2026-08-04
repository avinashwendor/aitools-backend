import { User } from '../models/index.js';
import { generateToken } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * Register a new user
 * POST /api/auth/signup
 */
export const signup = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new ApiError(400, 'Email already registered');
    }
    
    // Create new user
    const user = await User.create({
      name,
      email,
      password,
    });
    
    // Generate token
    const token = generateToken(user._id);
    
    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar,
          // Carried so the client can render the plan and credit balance on
          // the first paint after auth, instead of flashing a default state
          // until a follow-up /billing/me lands.
          subscription: user.subscription,
          credits: user.credits,
        },
        token,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Login user
 * POST /api/auth/signin
 */
export const signin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    // Find user with password field
    const user = await User.findOne({ email }).select('+password');
    
    if (!user) {
      throw new ApiError(401, 'Invalid email or password');
    }
    
    // Check password
    const isValidPassword = await user.comparePassword(password);
    if (!isValidPassword) {
      throw new ApiError(401, 'Invalid email or password');
    }
    
    // Check if account is active
    if (!user.isActive) {
      throw new ApiError(401, 'Account is deactivated');
    }
    
    // Update last login
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });
    
    // Generate token
    const token = generateToken(user._id);
    
    res.json({
      success: true,
      message: 'Signed in successfully',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar,
          // Carried so the client can render the plan and credit balance on
          // the first paint after auth, instead of flashing a default state
          // until a follow-up /billing/me lands.
          subscription: user.subscription,
          credits: user.credits,
        },
        token,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get current user profile
 * GET /api/auth/me
 */
export const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('savedTools', 'name slug logo category')
      .populate('likedTools', 'name slug logo category');
    
    res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update current user profile
 * PUT /api/auth/me
 */
export const updateMe = async (req, res, next) => {
  try {
    const { name, bio, avatar, reminders } = req.body;
    
    const updates = {};
    if (name) updates.name = name;
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (reminders && typeof reminders === 'object') {
      if (typeof reminders.emailDigest === 'boolean') {
        updates['reminders.emailDigest'] = reminders.emailDigest;
      }
      if (typeof reminders.staleNudge === 'boolean') {
        updates['reminders.staleNudge'] = reminders.staleNudge;
      }
      if (typeof reminders.weeklySummary === 'boolean') {
        updates['reminders.weeklySummary'] = reminders.weeklySummary;
      }
    }
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      updates,
      { new: true, runValidators: true }
    );
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: { user },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Change password
 * PUT /api/auth/password
 */
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    const user = await User.findById(req.user.id).select('+password');
    
    const isValidPassword = await user.comparePassword(currentPassword);
    if (!isValidPassword) {
      throw new ApiError(400, 'Current password is incorrect');
    }
    
    user.password = newPassword;
    await user.save();
    
    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    next(error);
  }
};

