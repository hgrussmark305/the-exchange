```python
# recommendation_engine.py
import pandas as pd
import numpy as np
from scipy.sparse import csr_matrix
from scipy.spatial.distance import cosine
from sklearn.decomposition import TruncatedSVD, NMF
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_squared_error
import pickle
import logging
from typing import List, Dict, Tuple, Optional
import json
from datetime import datetime
import redis
import hashlib

class DataProcessor:
    """Handles data preprocessing and feature engineering for recommendation system"""
    
    def __init__(self, min_interactions: int = 5):
        self.min_interactions = min_interactions
        self.user_encoder = {}
        self.item_encoder = {}
        self.user_decoder = {}
        self.item_decoder = {}
        
    def preprocess_interactions(self, interactions_df: pd.DataFrame) -> pd.DataFrame:
        """
        Preprocess interaction data by filtering users/items with minimum interactions
        and encoding categorical variables
        """
        # Remove duplicates and sort by timestamp
        interactions_df = interactions_df.drop_duplicates(['user_id', 'item_id']).copy()
        
        # Filter users and items with minimum interactions
        user_counts = interactions_df['user_id'].value_counts()
        item_counts = interactions_df['item_id'].value_counts()
        
        valid_users = user_counts[user_counts >= self.min_interactions].index
        valid_items = item_counts[item_counts >= self.min_interactions].index
        
        interactions_df = interactions_df[
            (interactions_df['user_id'].isin(valid_users)) & 
            (interactions_df['item_id'].isin(valid_items))
        ]
        
        # Encode user and item IDs
        unique_users = interactions_df['user_id'].unique()
        unique_items = interactions_df['item_id'].unique()
        
        self.user_encoder = {user: idx for idx, user in enumerate(unique_users)}
        self.item_encoder = {item: idx for idx, item in enumerate(unique_items)}
        self.user_decoder = {idx: user for user, idx in self.user_encoder.items()}
        self.item_decoder = {idx: item for item, idx in self.item_encoder.items()}
        
        interactions_df['user_idx'] = interactions_df['user_id'].map(self.user_encoder)
        interactions_df['item_idx'] = interactions_df['item_id'].map(self.item_encoder)
        
        return interactions_df
    
    def create_interaction_matrix(self, interactions_df: pd.DataFrame, 
                                rating_col: str = 'rating') -> csr_matrix:
        """Create sparse user-item interaction matrix"""
        n_users = len(self.user_encoder)
        n_items = len(self.item_encoder)
        
        # Handle implicit feedback (no ratings)
        if rating_col not in interactions_df.columns:
            interactions_df[rating_col] = 1.0
        
        # Create sparse matrix
        interaction_matrix = csr_matrix(
            (interactions_df[rating_col].values,
             (interactions_df['user_idx'].values, interactions_df['item_idx'].values)),
            shape=(n_users, n_items)
        )
        
        return interaction_matrix

class CollaborativeFilteringModel:
    """Implements collaborative filtering using matrix factorization"""
    
    def __init__(self, n_components: int = 50, random_state: int = 42):
        self.n_components = n_components
        self.random_state = random_state
        self.svd_model = None
        self.user_factors = None
        self.item_factors = None
        self.global_mean = None
        self.user_biases = None
        self.item_biases = None
        
    def fit(self, interaction_matrix: csr_matrix):
        """Train collaborative filtering model using SVD"""
        # Calculate global mean and biases
        self.global_mean = interaction_matrix.data.mean()
        
        # User and item biases
        user_sums = np.array(interaction_matrix.sum(axis=1)).flatten()
        user_counts = np.array((interaction_matrix > 0).sum(axis=1)).flatten()
        self.user_biases = np.divide(user_sums, user_counts, 
                                   out=np.zeros_like(user_sums), where=user_counts!=0) - self.global_mean
        
        item_sums = np.array(interaction_matrix.sum(axis=0)).flatten()
        item_counts = np.array((interaction_matrix > 0).sum(axis=0)).flatten()
        self.item_biases = np.divide(item_sums, item_counts,
                                   out=np.zeros_like(item_sums), where=item_counts!=0) - self.global_mean
        
        # Apply SVD
        self.svd_model = TruncatedSVD(n_components=self.n_components, 
                                     random_state=self.random_state)
        self.user_factors = self.svd_model.fit_transform(interaction_matrix)
        self.item_factors = self.svd_model.components_.T
        
    def predict(self, user_idx: int, item_idx: int) -> float:
        """Predict rating for user-item pair"""
        if user_idx >= len(self.user_factors) or item_idx >= len(self.item_factors):
            return self.global_mean
        
        prediction = (self.global_mean + 
                     self.user_biases[user_idx] + 
                     self.item_biases[item_idx] +
                     np.dot(self.user_factors[user_idx], self.item_factors[item_idx]))
        
        return max(0, min(5, prediction))  # Clamp between 0-5
    
    def get_user_recommendations(self, user_idx: int, n_recommendations: int = 10,
                               exclude_seen: set = None) -> List[Tuple[int, float]]:
        """Get top N recommendations for a user"""
        if user_idx >= len(self.user_factors):
            return []
        
        if exclude_seen is None:
            exclude_seen = set()
        
        # Calculate scores for all items
        user_vector = self.user_factors[user_idx]
        scores = np.dot(self.item_factors, user_vector)
        scores += self.item_biases
        scores += self.user_biases[user_idx] + self.global_mean
        
        # Get top recommendations excluding seen items
        item_scores = [(idx, score) for idx, score in enumerate(scores) 
                      if idx not in exclude_seen]
        item_scores.sort(key=lambda x: x[1], reverse=True)
        
        return item_scores[:n_recommendations]

class ContentBasedModel:
    """Content-based filtering for cold start problems"""
    
    def __init__(self, max_features: int = 5000):
        self.max_features = max_features
        self.tfidf_vectorizer = None
        self.item_features = None
        self.item_similarity_matrix = None
        
    def fit(self, items_df: pd.DataFrame, feature_cols: List[str]):
        """Train content-based model using item features"""
        # Combine text features
        items_df['combined_features'] = items_df[feature_cols].apply(
            lambda x: ' '.join(x.astype(str)), axis=1
        )
        
        # Create TF-IDF vectors
        self.tfidf_vectorizer = TfidfVectorizer(
            max_features=self.max_features,
            stop_words='english',
            lowercase=True
        )
        
        self.item_features = self.tfidf_vectorizer.fit_transform(
            items_df['combined_features']
        )
        
        # Calculate item similarity matrix
        self.item_similarity_matrix = cosine_similarity(self.item_features)
    
    def get_similar_items(self, item_idx: int, n_similar: int = 10) -> List[Tuple[int, float]]:
        """Get similar items based on content features"""
        if item_idx >= self.item_similarity_matrix.shape[0]:
            return []
        
        similarities = self.item_similarity_matrix[item_idx]
        similar_items = [(idx, sim) for idx, sim in enumerate(similarities) 
                        if idx != item_idx]
        similar_items.sort(key=lambda x: x[1], reverse=True)
        
        return similar_items[:n_similar]

class HybridRecommendationEngine:
    """Main recommendation engine combining multiple approaches"""
    
    def __init__(self, cf_weight: float = 0.7, cb_weight: float = 0.3):
        self.cf_weight = cf_weight
        self.cb_weight = cb_weight
        self.data_processor = DataProcessor()
        self.cf_model = CollaborativeFilteringModel()
        self.cb_model = ContentBasedModel()
        self.interaction_matrix = None
        self.user_item_interactions = {}
        self.is_trained = False
        
        # Setup logging
        logging.basicConfig(level=logging.INFO)
        self.logger = logging.getLogger(__name__)
        
    def train(self, interactions_df: pd.DataFrame, items_df: pd.DataFrame,
              content_features: List[str]):
        """Train the hybrid recommendation system"""
        try:
            self.logger.info("Starting model training...")
            
            # Preprocess data
            interactions_clean = self.data_processor.preprocess_interactions(interactions_df)
            self.interaction_matrix = self.data_processor.create_interaction_matrix(interactions_clean)
            
            # Store user-item interactions for filtering
            for _, row in interactions_clean.iterrows():
                user_idx = row['user_idx']
                item_idx = row['item_idx']
                if user_idx not in self.user_item_interactions:
                    self.user_item_interactions[user_idx] = set()
                self.user_item_interactions[user_idx].add(item_idx)
            
            # Train collaborative filtering model
            self.cf_model.fit(self.interaction_matrix)
            
            # Train content-based model
            self.cb_model.fit(items_df, content_features)
            
            self.is_trained = True
            self.logger.info("Model training completed successfully")
            
        except Exception as e:
            self.logger.error(f"Error during training: {str(e)}")
            raise
    
    def get_recommendations(self, user_id: str, n_recommendations: int = 10) -> List[Dict]:
        """Get hybrid recommendations for a user"""
        if not self.is_trained:
            raise ValueError("Model must be trained before making recommendations")
        
        recommendations = []
        
        # Check if user exists in training data
        if user_id in self.data_processor.user_encoder:
            user_idx = self.data_processor.user_encoder[user_id]
            seen_items = self.user_item_interactions.get(user_idx, set())
            
            # Get collaborative filtering recommendations
            cf_recs = self.cf_model.get_user_recommendations(
                user_idx, n_recommendations * 2, seen_items
            )
            
            # Combine with content-based recommendations
            cf_scores = {item_idx: score for item_idx, score in cf_recs}
            
            # Get content-based recommendations based on user's interaction history
            cb_scores = {}
            if seen_items:
                for seen_item in list(seen_items)[:5]:  # Use last 5 interactions
                    similar_items = self.cb_model.get_similar_items(seen_item, 20)
                    for item_idx, similarity in similar_items:
                        if item_idx not in seen_items:
                            cb_scores[item_idx] = cb_scores.get(item_idx, 0) + similarity
            
            # Combine scores
            all_items = set(cf_scores.keys()) | set(cb_scores.keys())
            hybrid_scores = []
            
            for item_idx in all_items:
                cf_score = cf_scores.get(item_idx, 0)
                cb_score = cb_scores.get(item_idx, 0)
                hybrid_score = self.cf_weight * cf_score + self.cb_weight * cb_score
                hybrid_scores.append((item_idx, hybrid_score, cf_score, cb_score))
            
            # Sort by hybrid score
            hybrid_scores.sort(key=lambda x: x[1], reverse=True)
            
            # Format recommendations
            for item_idx, hybrid_score, cf_score, cb_score in hybrid_scores[:n_recommendations]:
                item_id = self.data_processor.item_decoder[item_idx]
                recommendations.append({
                    'item_id': item_id,
                    'score': float(hybrid_score),
                    'cf_score': float(cf_score),
                    'cb_score': float(cb_score),
                    'method': 'hybrid'
                })
        
        else:
            # Cold start - use popular items
            self.logger.info(f"Cold start recommendation for user {user_id}")
            recommendations = self._get_popular_items(n_recommendations)
        
        return recommendations
    
    def _get_popular_items(self, n_items: int = 10) -> List[Dict]:
        """Get popular items for cold start scenarios"""
        item_popularity = np.array(self.interaction_matrix.sum(axis=0)).flatten()
        popular_items = np.argsort(item_popularity)[::-1][:n_items]
        
        recommendations = []
        for item_idx in popular_items:
            item_id = self.data_processor.item_decoder[item_idx]
            recommendations.append({
                'item_id': item_id,
                'score': float(item_popularity[item_idx]),
                'cf_score': 0.0,
                'cb_score': 0.0,
                'method': 'popular'
            })
        
        return recommendations
    
    def evaluate(self, test_interactions: pd.DataFrame) -> Dict[str, float]:
        """Evaluate model performance"""
        if not self.is_trained:
            raise ValueError("Model must be trained before evaluation")
        
        # Preprocess test data
        test_clean = test_interactions.copy()
        test_clean = test_clean[
            (test_clean['user_id'].isin(self.data_processor.user_encoder.keys())) &
            (test_clean['item_id'].isin(self.data_processor.item_encoder.keys()))
        ]
        
        if test_clean.empty:
            return {'rmse': float('inf'), 'mae': float('inf')}
        
        test_clean['user_idx'] = test_clean['user_id'].map(self.data_processor.user_encoder)
        test_clean['item_idx'] = test_clean['item_id'].map(self.data_processor.item_encoder)
        
        # Calculate predictions
        predictions = []
        actual = []
        
        for _, row in test_clean.iterrows():
            pred = self.cf_model.predict(row['user_idx'], row['item_idx'])
            predictions.append(pred)
            actual.append(row.get('rating', 1.0))
        
        # Calculate metrics
        rmse = np.sqrt(mean_squared_error(actual, predictions))
        mae = np.mean(np.abs(np.array(actual