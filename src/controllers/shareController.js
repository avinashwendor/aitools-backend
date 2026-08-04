import SharedWorkflow, {
  sanitizeWorkflowForShare,
  makeShareSlug,
} from '../models/SharedWorkflow.js';
import { loadConversation } from '../ai/memory.js';

export const shareWorkflow = async (req, res, next) => {
  try {
    const sessionId = req.params.sessionId || req.body.sessionId;
    const visibility = req.body.visibility === 'unlisted' ? 'unlisted' : 'public';

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const conversation = await loadConversation(req.user._id, sessionId);
    const workflow = conversation.lastWorkflow;
    if (!workflow?.stages?.length) {
      return res.status(404).json({
        success: false,
        message: 'No workflow in that session to share',
      });
    }

    const snapshot = sanitizeWorkflowForShare(workflow);
    let record = await SharedWorkflow.findOne({
      user: req.user._id,
      sessionId,
    });

    if (record) {
      record.workflow = snapshot;
      record.title = snapshot.title || '';
      record.outcome = snapshot.outcome || '';
      record.visibility = visibility;
      await record.save();
    } else {
      record = await SharedWorkflow.create({
        slug: makeShareSlug(snapshot.title),
        user: req.user._id,
        sessionId,
        visibility,
        workflow: snapshot,
        title: snapshot.title || '',
        outcome: snapshot.outcome || '',
      });
    }

    res.json({
      success: true,
      data: {
        slug: record.slug,
        visibility: record.visibility,
        path: `/w/${record.slug}`,
        title: record.title,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const unshareWorkflow = async (req, res, next) => {
  try {
    const deleted = await SharedWorkflow.findOneAndDelete({
      slug: req.params.slug,
      user: req.user._id,
    });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Shared workflow not found' });
    }
    res.json({ success: true, message: 'Share removed' });
  } catch (err) {
    next(err);
  }
};

export const getPublicWorkflow = async (req, res, next) => {
  try {
    const record = await SharedWorkflow.findOne({ slug: req.params.slug }).lean();
    if (!record) {
      return res.status(404).json({ success: false, message: 'Shared workflow not found' });
    }

    res.json({
      success: true,
      data: {
        slug: record.slug,
        visibility: record.visibility,
        title: record.title,
        outcome: record.outcome,
        workflow: record.workflow,
        sharedAt: record.updatedAt || record.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const getMyShare = async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }
    const record = await SharedWorkflow.findOne({
      user: req.user._id,
      sessionId,
    })
      .select('slug visibility title updatedAt')
      .lean();

    res.json({
      success: true,
      data: {
        share: record
          ? {
              slug: record.slug,
              visibility: record.visibility,
              path: `/w/${record.slug}`,
              title: record.title,
            }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
};
